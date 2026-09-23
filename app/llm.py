"""Слой провайдеров модели.

Провайдер выбирается переменной LLM_PROVIDER:

    groq    — бесплатный облачный API GroqCloud (OpenAI-совместимый), нужен GROQ_API_KEY
    openai  — любой OpenAI-совместимый API: OpenRouter, LM Studio, vLLM, свой прокси…
    ollama  — локальный Ollama на 11434
    demo    — без сети и без модели: заготовленные тёплые ответы для показа

Если LLM_PROVIDER не задан: есть GROQ_API_KEY → groq, иначе ollama.

LLM_FALLBACK=demo — если основная модель не ответила (нет сети, кончился лимит),
разговор продолжится на заготовках, а не оборвётся ошибкой. Удобно на презентации.

Наружу модуль отдаёт четыре функции, которые использует main.py:
stream_chat, complete, list_models, model_exists — и исключение LLMError.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from typing import AsyncIterator

import httpx

from . import config

log = logging.getLogger("tihiy-chas.llm")


class LLMError(RuntimeError):
    """Модель недоступна или вернула ошибку."""


# Старое имя — чтобы не ломать сторонний код, который его ловил.
OllamaError = LLMError


# --------------------------------------------------------------------------- общее


def provider() -> str:
    return config.LLM_PROVIDER


def model_name() -> str:
    return {
        "ollama": config.OLLAMA_MODEL,
        "demo": "демо-режим",
    }.get(provider(), _RESOLVED.get(_resolve_key()) or config.LLM_MODEL)


# --------------------------------------------------------------------------- выбор модели

# Если указанной модели у сервиса нет (опечатка, модель сняли с поддержки),
# берём первую доступную из этого списка — разговор не должен ломаться.
# С 16.08.2026 Llama убраны из бесплатного тарифа Groq — основная теперь gpt-oss.
PREFERRED_MODELS = [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
]
_SKIP = ("whisper", "guard", "tts", "orpheus", "playai", "distil", "safeguard", "allam", "compound")
_FAMILIES = ("gpt-oss-120b", "llama-3.3-70b", "kimi", "llama-4", "qwen", "gpt-oss", "llama", "mistral", "gemma")

_RESOLVED: dict[tuple, str] = {}


def _resolve_key() -> tuple:
    return (config.LLM_BASE_URL, config.LLM_MODEL)


def pick_model(wanted: str, available: list[str]) -> str | None:
    """Точное имя → имя, которое начинается с указанного → запасные модели."""
    if not available or wanted in available:
        return wanted or None
    low = wanted.lower()
    if low:
        for name in available:
            if name.lower() == low or name.lower().startswith(low) or name.lower().endswith("/" + low):
                return name
    for name in PREFERRED_MODELS:
        if name in available:
            return name
    chat = [n for n in available if not any(bad in n.lower() for bad in _SKIP)]
    # имена могли смениться (например, получить префикс) — ищем по семействам
    for family in _FAMILIES:
        for name in chat:
            if family in name.lower():
                return name
    return chat[0] if chat else None


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(config.LLM_TIMEOUT, connect=10.0)


def _client(timeout: httpx.Timeout | float) -> httpx.AsyncClient:
    # LLM_PROXY — если облачный API недоступен из вашей сети напрямую.
    # Без него httpx всё равно учитывает системные HTTPS_PROXY / ALL_PROXY.
    if config.LLM_PROXY:
        return httpx.AsyncClient(timeout=timeout, proxy=config.LLM_PROXY)
    return httpx.AsyncClient(timeout=timeout)


class _ThinkFilter:
    """Вырезает <think>…</think> из потока: так размышляют Qwen, DeepSeek и др."""

    def __init__(self) -> None:
        self.buffer = ""
        self.inside = False

    def feed(self, piece: str) -> str:
        self.buffer += piece
        out = []
        while self.buffer:
            if self.inside:
                end = self.buffer.find("</think>")
                if end < 0:
                    # держим хвост, вдруг закрывающий тег разрезан пополам
                    self.buffer = self.buffer[-8:]
                    return "".join(out)
                self.buffer = self.buffer[end + 8 :].lstrip()
                self.inside = False
            else:
                start = self.buffer.find("<think>")
                if start < 0:
                    # не отдаём хвост, похожий на начало тега
                    keep = next(
                        (k for k in range(min(7, len(self.buffer)), 0, -1) if "<think>".startswith(self.buffer[-k:])),
                        0,
                    )
                    out.append(self.buffer[: len(self.buffer) - keep])
                    self.buffer = self.buffer[len(self.buffer) - keep :]
                    return "".join(out)
                out.append(self.buffer[:start])
                self.buffer = self.buffer[start + 7 :]
                self.inside = True
        return "".join(out)

    def flush(self) -> str:
        rest = "" if self.inside else self.buffer
        self.buffer = ""
        return rest


def strip_think(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()


# --------------------------------------------------------------------------- публичные функции


async def stream_chat(messages: list[dict]) -> AsyncIterator[str]:
    """Ответ модели по частям. При LLM_FALLBACK=demo — подстраховка заготовками."""
    started = False
    try:
        async for piece in _PROVIDERS[provider()].stream(messages):
            started = True
            yield piece
    except LLMError as exc:
        if started or not _fallback_enabled():
            raise
        log.warning("Модель не ответила (%s) — отвечаю в демо-режиме", exc)
        async for piece in demo_stream(messages):
            yield piece


async def complete(messages: list[dict], num_predict: int = 500) -> str:
    """Ответ целиком, без потока — для итога разговора."""
    try:
        return strip_think(await _PROVIDERS[provider()].complete(messages, num_predict))
    except LLMError:
        if not _fallback_enabled():
            raise
        return demo_summary(messages)


async def list_models() -> list[str]:
    return await _PROVIDERS[provider()].list_models()


async def model_exists(name: str) -> bool | None:
    return await _PROVIDERS[provider()].model_exists(name)


def _fallback_enabled() -> bool:
    return config.LLM_FALLBACK == "demo" and provider() != "demo"


# --------------------------------------------------------------------------- OpenAI-совместимые (Groq, OpenRouter…)


class OpenAICompatible:
    """POST {base}/chat/completions со stream=true, ответ — SSE `data: {...}`."""

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if config.LLM_API_KEY:
            headers["Authorization"] = f"Bearer {config.LLM_API_KEY}"
        if "openrouter.ai" in config.LLM_BASE_URL:
            # OpenRouter просит представиться — это видно в их статистике
            headers["HTTP-Referer"] = "http://localhost"
            headers["X-Title"] = "Tihiy chas"
        return headers

    async def model(self) -> str:
        """Модель, которой реально отвечаем. Выбирается один раз на процесс."""
        key = _resolve_key()
        if key in _RESOLVED:
            return _RESOLVED[key]
        try:
            available = await self.list_models()
        except Exception:  # noqa: BLE001 — нет списка: пробуем как указано
            return config.LLM_MODEL
        chosen = pick_model(config.LLM_MODEL, available) or config.LLM_MODEL
        if chosen != config.LLM_MODEL:
            log.warning("Модели «%s» нет у сервиса — отвечаю моделью «%s»", config.LLM_MODEL, chosen)
        _RESOLVED[key] = chosen
        return chosen

    def _payload(self, messages: list[dict], max_tokens: int, temperature: float, stream: bool, model: str) -> dict:
        payload = {
            "model": model,
            "messages": messages,
            "stream": stream,
            "temperature": temperature,
            "top_p": config.TOP_P,
            "max_tokens": max_tokens,
        }
        if model.startswith("openai/gpt-oss"):
            # рассуждающая модель: думать недолго, иначе ответ съест лимит токенов
            payload["reasoning_effort"] = "low"
            payload["max_tokens"] = max_tokens + 600
        return payload

    def _check_key(self) -> None:
        if not config.LLM_API_KEY:
            raise LLMError(
                "Не задан ключ API. Добавьте в .env строку GROQ_API_KEY=gsk_… "
                "(ключ выдают бесплатно на console.groq.com/keys) и перезапустите сервер."
            )

    async def stream(self, messages: list[dict]) -> AsyncIterator[str]:
        self._check_key()
        model = await self.model()
        if not model:
            raise LLMError("Не указана модель. Добавьте в .env строку LLM_MODEL=… и перезапустите сервер.")
        payload = self._payload(messages, config.NUM_PREDICT, config.TEMPERATURE, True, model)
        think = _ThinkFilter()
        async with _client(_timeout()) as client:
            try:
                async with client.stream(
                    "POST", f"{config.LLM_BASE_URL}/chat/completions", json=payload, headers=self._headers()
                ) as response:
                    if response.status_code >= 400:
                        body = (await response.aread()).decode("utf-8", "replace")
                        raise LLMError(_explain_http(response.status_code, body))

                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        if chunk.get("error"):
                            raise LLMError(_error_text(chunk["error"]))
                        choices = chunk.get("choices") or [{}]
                        piece = (choices[0].get("delta") or {}).get("content") or ""
                        piece = think.feed(piece)
                        if piece:
                            yield piece
                    tail = think.flush()
                    if tail:
                        yield tail
            except httpx.ConnectError as exc:
                raise LLMError(
                    f"Не удаётся подключиться к {config.LLM_BASE_URL}. Проверьте интернет "
                    "(или VPN / LLM_PROXY, если сервис недоступен из вашей сети)."
                ) from exc
            except httpx.TimeoutException as exc:
                raise LLMError("Модель не ответила за отведённое время. Попробуйте ещё раз.") from exc
            except httpx.HTTPError as exc:
                raise LLMError(_network_hint(exc)) from exc

    async def complete(self, messages: list[dict], num_predict: int) -> str:
        self._check_key()
        payload = self._payload(messages, num_predict, 0.5, False, await self.model() or config.LLM_MODEL)
        async with _client(_timeout()) as client:
            try:
                response = await client.post(
                    f"{config.LLM_BASE_URL}/chat/completions", json=payload, headers=self._headers()
                )
            except httpx.ConnectError as exc:
                raise LLMError(f"Не удаётся подключиться к {config.LLM_BASE_URL}.") from exc
            except httpx.TimeoutException as exc:
                raise LLMError("Модель не ответила за отведённое время.") from exc
            except httpx.HTTPError as exc:
                raise LLMError(_network_hint(exc)) from exc
        if response.status_code >= 400:
            raise LLMError(_explain_http(response.status_code, response.text))
        data = response.json()
        choices = data.get("choices") or [{}]
        return ((choices[0].get("message") or {}).get("content") or "").strip()

    async def list_models(self) -> list[str]:
        self._check_key()
        async with _client(10) as client:
            try:
                response = await client.get(f"{config.LLM_BASE_URL}/models", headers=self._headers())
            except httpx.HTTPError as exc:
                raise LLMError(
                    f"Не удаётся подключиться к {config.LLM_BASE_URL}: {exc.__class__.__name__}. "
                    "Проверьте интернет или VPN."
                ) from exc
        if response.status_code >= 400:
            raise LLMError(_explain_http(response.status_code, response.text))
        return sorted(m.get("id", "") for m in response.json().get("data", []))

    async def model_exists(self, name: str) -> bool | None:
        try:
            models = await self.list_models()
        except LLMError:
            return None
        return name in models if models else None


def _network_hint(exc: httpx.HTTPError) -> str:
    if isinstance(exc, httpx.ProxyError):
        return f"Прокси не пропустил запрос ({exc}). Проверьте LLM_PROXY / системный прокси или VPN."
    return f"Сетевая ошибка: {exc.__class__.__name__} {exc}".strip()


def _error_text(error) -> str:
    if isinstance(error, dict):
        return str(error.get("message") or error)
    return str(error)


def _explain_http(status: int, body: str) -> str:
    """Понятное сообщение вместо сырого ответа облачного API."""
    try:
        detail = _error_text(json.loads(body).get("error", body))
    except (ValueError, AttributeError):
        detail = body.strip()
    detail = detail[:240]
    service = "Groq" if "groq.com" in config.LLM_BASE_URL else "API"

    if status == 401:
        return f"{service} не принял ключ. Проверьте GROQ_API_KEY / LLM_API_KEY в .env — его можно перевыпустить на console.groq.com/keys."
    if status == 403:
        return (
            f"{service} отказал в доступе (403). Чаще всего так бывает, когда сервис "
            "недоступен из вашей страны: включите VPN или укажите LLM_PROXY в .env. "
            f"Ответ: {detail}"
        )
    if status == 404:
        return f"Модель «{config.LLM_MODEL}» не найдена у {service}. Укажите другую в LLM_MODEL. Ответ: {detail}"
    if status == 429:
        return "Бесплатный лимит на минуту исчерпан. Подождите полминуты и отправьте ещё раз."
    if status == 413:
        return "Разговор стал слишком длинным для бесплатного лимита. Начните новый разговор."
    if status >= 500:
        return f"{service} временно не отвечает ({status}). Попробуйте через минуту."
    return f"{service} вернул ошибку {status}: {detail}"


# --------------------------------------------------------------------------- Ollama


class Ollama:
    async def list_models(self) -> list[str]:
        async with httpx.AsyncClient(timeout=10) as client:
            try:
                response = await client.get(f"{config.OLLAMA_URL}/api/tags")
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise LLMError(str(exc) or f"Ollama не отвечает на {config.OLLAMA_URL}") from exc
        return [m.get("name", "") for m in response.json().get("models", [])]

    async def model_exists(self, name: str) -> bool | None:
        """/api/tags не показывает облачные модели (*-cloud), поэтому смотрим /api/show."""
        async with httpx.AsyncClient(timeout=15) as client:
            try:
                response = await client.post(f"{config.OLLAMA_URL}/api/show", json={"model": name})
            except httpx.HTTPError:
                return None
        if response.status_code == 200:
            return True
        if response.status_code == 404:
            try:
                return name in await self.list_models()
            except LLMError:
                return None
        return None

    async def stream(self, messages: list[dict]) -> AsyncIterator[str]:
        payload = {
            "model": config.OLLAMA_MODEL,
            "messages": messages,
            "stream": True,
            "options": {
                "temperature": config.TEMPERATURE,
                "top_p": config.TOP_P,
                "num_predict": config.NUM_PREDICT,
            },
        }
        think = _ThinkFilter()
        async with httpx.AsyncClient(timeout=httpx.Timeout(config.OLLAMA_TIMEOUT, connect=10.0)) as client:
            try:
                async with client.stream("POST", f"{config.OLLAMA_URL}/api/chat", json=payload) as response:
                    if response.status_code >= 400:
                        body = (await response.aread()).decode("utf-8", "replace")
                        raise LLMError(_explain_ollama(response.status_code, body))
                    async for line in response.aiter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if chunk.get("error"):
                            raise LLMError(str(chunk["error"]))
                        piece = think.feed((chunk.get("message") or {}).get("content", ""))
                        if piece:
                            yield piece
                        if chunk.get("done"):
                            break
                    tail = think.flush()
                    if tail:
                        yield tail
            except httpx.ConnectError as exc:
                raise LLMError(
                    f"Не удаётся подключиться к Ollama на {config.OLLAMA_URL}. "
                    "Проверьте, что он запущен: `ollama serve`."
                ) from exc
            except httpx.ReadTimeout as exc:
                raise LLMError(
                    "Ollama не ответил за отведённое время. "
                    "Для большой модели увеличьте OLLAMA_TIMEOUT в .env."
                ) from exc
            except httpx.HTTPError as exc:
                raise LLMError(f"Ollama: {_network_hint(exc)}") from exc

    async def complete(self, messages: list[dict], num_predict: int) -> str:
        payload = {
            "model": config.OLLAMA_MODEL,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0.5, "top_p": 0.9, "num_predict": num_predict},
        }
        async with httpx.AsyncClient(timeout=httpx.Timeout(config.OLLAMA_TIMEOUT, connect=10.0)) as client:
            try:
                response = await client.post(f"{config.OLLAMA_URL}/api/chat", json=payload)
            except httpx.ConnectError as exc:
                raise LLMError(
                    f"Не удаётся подключиться к Ollama на {config.OLLAMA_URL}. "
                    "Проверьте, что он запущен: `ollama serve`."
                ) from exc
            except httpx.ReadTimeout as exc:
                raise LLMError("Ollama не ответил за отведённое время.") from exc
            except httpx.HTTPError as exc:
                raise LLMError(f"Ollama: {_network_hint(exc)}") from exc
        if response.status_code >= 400:
            raise LLMError(_explain_ollama(response.status_code, response.text))
        data = response.json()
        if data.get("error"):
            raise LLMError(str(data["error"]))
        return ((data.get("message") or {}).get("content") or "").strip()


def _explain_ollama(status: int, body: str) -> str:
    if status == 404:
        return (
            f"Модель «{config.OLLAMA_MODEL}» не найдена в Ollama. "
            f"Установите её: `ollama pull {config.OLLAMA_MODEL}` "
            "(для облачных моделей сначала `ollama signin`) "
            "или укажите другую в OLLAMA_MODEL."
        )
    if status in (401, 403):
        return (
            "Ollama отказал в доступе к модели. Для облачных моделей "
            "(*-cloud) нужно войти в аккаунт Ollama: `ollama signin`."
        )
    return f"Ollama вернул ошибку {status}: {body.strip()[:300]}"


# --------------------------------------------------------------------------- демо без сети

# Заготовки не притворяются терапией: отражают сказанное, задают один вопрос
# и предлагают практику, которая в приложении работает по-настоящему.
_DEMO_REPLIES: list[tuple[tuple[str, ...], list[str]]] = [
    (
        ("трев", "волну", "паник", "страш", "боюсь", "переживаю"),
        [
            "Похоже, внутри сейчас неспокойно, и это выматывает. Тревога часто говорит громче, чем стоит, — но от этого она не менее ощутима. "
            "Что сейчас тревожит сильнее всего — что-то конкретное или скорее общее чувство, что всё может пойти не так?",
            "Слышу, как много в этом напряжения. Если хочется, можем сначала немного замедлиться: кнопка «Дыхание» справа — минута ровного вдоха и выдоха. "
            "А потом расскажете, с чего это началось сегодня?",
        ],
    ),
    (
        ("сон", "спать", "усну", "бессон", "ночью", "просыпа"),
        [
            "Когда не получается уснуть, ночь тянется бесконечно, а мысли будто становятся громче. Это очень знакомое многим состояние. "
            "Что обычно крутится в голове, когда вы лежите без сна?",
            "Похоже, отдыха сейчас не хватает, и это отражается на всём дне. Иногда помогает дыхание 4-7-8 прямо в кровати — оно есть в «Дыхании». "
            "А как давно сон стал таким?",
        ],
    ),
    (
        ("работ", "началь", "дедлайн", "выгора", "устал", "учёб", "учеб", "экзам"),
        [
            "Звучит так, будто сил уходит больше, чем успевает восстановиться. Усталость — это не слабость, а сигнал, что нагрузка давно превышает ресурс. "
            "Что из этого забирает больше всего энергии?",
            "Понимаю, когда требований много, а передышек мало, легко перестать замечать себя. "
            "Если представить, что одну вещь на этой неделе можно убрать или отложить, — что бы это было?",
        ],
    ),
    (
        ("один", "одинок", "никто", "не с кем", "друз", "пуст"),
        [
            "Одиночество бывает очень тяжёлым — особенно когда вокруг вроде бы люди, а поделиться не с кем. Спасибо, что написали сюда. "
            "Как давно вы чувствуете это так остро?",
            "Слышу, что не хватает рядом кого-то, кто просто поймёт. Здесь можно говорить сколько нужно. "
            "Есть ли человек, с которым раньше было тепло общаться?",
        ],
    ),
    (
        ("парень", "девушк", "муж", "жена", "расст", "отношен", "ссор", "мама", "папа", "родител"),
        [
            "Когда больно в отношениях с близкими, это задевает особенно глубоко. "
            "Что в этой ситуации ранит сильнее всего?",
            "Похоже, в этих отношениях сейчас много непростого. Можно я уточню: чего вам больше всего не хватает от этого человека?",
        ],
    ),
    (
        ("груст", "плохо", "тоск", "плач", "тяжело", "депресс", "нет сил"),
        [
            "Мне жаль, что сейчас так тяжело. Не обязательно сразу разбираться, почему, — иногда достаточно просто назвать, что происходит. "
            "Когда вы заметили, что стало так?",
            "Слышу вас. Грусть имеет право быть, даже если кажется, что для неё нет «достаточной» причины. "
            "Что сегодня было самым трудным моментом?",
        ],
    ),
    (
        ("привет", "здравств", "добрый", "хай", "hello", "hi"),
        [
            "Привет. Я рядом и никуда не тороплюсь. Как вы сейчас — если одним словом?",
            "Здравствуйте. Рад, что заглянули. Расскажите, с чем пришли сегодня, — можно с чего угодно.",
        ],
    ),
    (
        ("спасибо", "помог", "легче", "лучше"),
        [
            "Я рад, что стало хоть немного легче. Это ваша заслуга — вы нашли время остановиться и прислушаться к себе. "
            "Хотите отметить настроение в дневнике, чтобы потом видеть, как оно меняется?",
        ],
    ),
]

_DEMO_DEFAULT = [
    "Слышу вас. Расскажите чуть подробнее — что сейчас чувствуете, когда говорите об этом?",
    "Спасибо, что делитесь. Мне важно понять лучше: как это отражается на вашем дне?",
    "Понимаю. Если прислушаться к себе прямо сейчас — чего больше всего хочется: выговориться, разобраться или просто немного успокоиться?",
]

_DEMO_GIBBERISH = "Кажется, сообщение получилось случайным набором букв — бывает. Напишите, как вы сейчас, я здесь."

_DEMO_CRISIS = (
    "Мне очень важно, что вы об этом сказали. То, что вы чувствуете, — серьёзно, и вы не должны проходить через это в одиночку. "
    "Пожалуйста, позвоните прямо сейчас по одному из номеров выше — там круглосуточно отвечают живые люди. "
    "Вы сейчас в безопасном месте? Есть ли рядом кто-то, кому можно написать?"
)


def _last_user(messages: list[dict]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return message.get("content", "")
    return ""


def _looks_like_gibberish(text: str) -> bool:
    letters = re.sub(r"[^a-zа-яё]", "", text.lower())
    if len(letters) < 3:
        return False
    vowels = sum(ch in "aeiouyаеёиоуыэюя" for ch in letters)
    return " " not in text.strip() and (vowels / len(letters) < 0.2 or len(set(letters)) <= 3)


def demo_reply(messages: list[dict]) -> str:
    from .safety import is_crisis

    text = _last_user(messages)
    lowered = text.lower()
    if is_crisis(text):
        return _DEMO_CRISIS
    if _looks_like_gibberish(text):
        return _DEMO_GIBBERISH

    turn = max(0, sum(1 for m in messages if m.get("role") == "user") - 1)
    for keys, replies in _DEMO_REPLIES:
        if any(key in lowered for key in keys):
            return replies[turn % len(replies)]
    return _DEMO_DEFAULT[turn % len(_DEMO_DEFAULT)]


async def demo_stream(messages: list[dict]) -> AsyncIterator[str]:
    """Печатает ответ по словам — выглядит так же, как живая модель."""
    await asyncio.sleep(0.5)
    for word in re.findall(r"\S+\s*", demo_reply(messages)):
        await asyncio.sleep(random.uniform(0.02, 0.06))
        yield word


def demo_summary(messages: list[dict]) -> str:
    transcript = messages[-1].get("content", "") if messages else ""
    said = [line[len("Человек: ") :] for line in transcript.splitlines() if line.startswith("Человек: ")]
    first = said[0][:140] if said else "о том, что сейчас происходит"
    return (
        "О чём говорили\n"
        f"Вы начали с того, что «{first}», и постепенно рассказали, как это отзывается в повседневной жизни.\n\n"
        "Что заметно\n"
        "Вы внимательны к своим чувствам и готовы о них говорить — это уже большой шаг. "
        "Похоже, сейчас особенно не хватает отдыха и опоры.\n\n"
        "Маленький шаг\n"
        "Сегодня вечером выделите пять минут только для себя: подышите в ровном ритме и отметьте настроение в дневнике."
    )


class Demo:
    async def stream(self, messages: list[dict]) -> AsyncIterator[str]:
        async for piece in demo_stream(messages):
            yield piece

    async def complete(self, messages: list[dict], num_predict: int) -> str:
        await asyncio.sleep(0.6)
        return demo_summary(messages)

    async def list_models(self) -> list[str]:
        return ["демо-режим"]

    async def model_exists(self, name: str) -> bool | None:
        return True


_PROVIDERS = {
    "groq": OpenAICompatible(),
    "openai": OpenAICompatible(),
    "ollama": Ollama(),
    "demo": Demo(),
}


async def active_model() -> str:
    """Какой моделью реально отвечаем (для OpenAI-совместимых — после автовыбора)."""
    impl = _PROVIDERS[provider()]
    if isinstance(impl, OpenAICompatible):
        return await impl.model()
    return model_name()
