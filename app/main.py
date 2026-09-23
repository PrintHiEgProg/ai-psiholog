"""ИИ Психолог «Тихий час» — FastAPI бэкенд.

Маршруты:
    GET  /             — лендинг
    GET  /app          — чат
    POST /api/chat     — ответ модели потоком (SSE)
    POST /api/summary  — итог разговора: о чём говорили, что заметно, маленький шаг
    POST /api/reset    — очистить историю сессии
    GET  /api/health   — провайдер, модель и связь с ней
"""

import json
import time
import uuid
from collections import deque
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, llm, safety
from .prompts import CRISIS_NUDGE, SUMMARY_PROMPT, SYSTEM_PROMPT, context_note

app = FastAPI(title="Тихий час", description="ИИ-собеседник для эмоциональной поддержки")

# История диалогов в памяти процесса: {session_id: {"messages": [...], "touched": ts}}
# Для MVP этого достаточно; ничего не пишется на диск — разговор живёт до перезапуска.
_SESSIONS: dict[str, dict] = {}


# --------------------------------------------------------------------------- модели запросов


class ChatContext(BaseModel):
    """То, что человек отметил сам: настроение, чувства, тема."""

    mood: int | None = Field(default=None, ge=1, le=5)
    feelings: list[str] = Field(default_factory=list, max_length=6)
    topic: str | None = Field(default=None, max_length=80)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    session_id: str | None = None
    context: ChatContext | None = None


class SessionRequest(BaseModel):
    session_id: str | None = None


ResetRequest = SessionRequest


# --------------------------------------------------------------------------- лимит запросов

_HITS: dict[str, deque] = {}


def _client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate(request: Request) -> None:
    """Скользящее окно в минуту на адрес. Защищает модель от перебора запросов."""
    limit = config.RATE_LIMIT_PER_MINUTE
    if limit <= 0:
        return
    now = time.time()
    hits = _HITS.setdefault(_client_key(request), deque())
    while hits and now - hits[0] > 60:
        hits.popleft()
    if len(hits) >= limit:
        wait = int(60 - (now - hits[0])) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Слишком много сообщений подряд. Передохните {wait} с и продолжим.",
        )
    hits.append(now)


# --------------------------------------------------------------------------- сессии


def _sweep_sessions() -> None:
    now = time.time()
    dead = [
        sid
        for sid, s in _SESSIONS.items()
        if now - s["touched"] > config.SESSION_TTL_SECONDS
    ]
    for sid in dead:
        _SESSIONS.pop(sid, None)


def _get_session(session_id: str | None) -> tuple[str, dict]:
    _sweep_sessions()
    if session_id and session_id in _SESSIONS:
        session = _SESSIONS[session_id]
        session["touched"] = time.time()
        return session_id, session

    new_id = session_id or uuid.uuid4().hex
    session = {"messages": [], "touched": time.time()}
    _SESSIONS[new_id] = session
    return new_id, session


def _trim(messages: list[dict]) -> list[dict]:
    """Оставляем последние N сообщений, чтобы контекст не разрастался."""
    if len(messages) <= config.MAX_HISTORY_MESSAGES:
        return messages
    return messages[-config.MAX_HISTORY_MESSAGES :]


# --------------------------------------------------------------------------- SSE


def _sse(event: str, **data) -> str:
    return f"data: {json.dumps({'event': event, **data}, ensure_ascii=False)}\n\n"


def _clean_feelings(items: list[str]) -> list[str]:
    cleaned = []
    for item in items:
        word = " ".join(str(item).split())[:30]
        if word and word not in cleaned:
            cleaned.append(word)
    return cleaned[:6]


@app.post("/api/chat")
async def chat(request: ChatRequest, http: Request):
    _check_rate(http)
    text = request.message.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Пустое сообщение")
    if len(text) > config.MAX_MESSAGE_CHARS:
        raise HTTPException(
            status_code=413,
            detail=f"Сообщение длиннее {config.MAX_MESSAGE_CHARS} символов",
        )

    session_id, session = _get_session(request.session_id)
    crisis = safety.is_crisis(text)

    session["messages"].append({"role": "user", "content": text})
    session["messages"] = _trim(session["messages"])

    if request.context:
        session["context"] = request.context
    stored = session.get("context")

    payload: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if stored:
        note = context_note(stored.mood, _clean_feelings(stored.feelings), stored.topic)
        if note:
            payload.append({"role": "system", "content": note})
    payload += session["messages"]
    if crisis:
        payload.append({"role": "system", "content": CRISIS_NUDGE})

    async def event_stream() -> AsyncIterator[str]:
        yield _sse("start", session_id=session_id)
        if crisis:
            yield _sse("crisis", helplines=safety.HELPLINES)

        collected: list[str] = []
        try:
            async for piece in llm.stream_chat(payload):
                collected.append(piece)
                yield _sse("token", text=piece)
        except Exception as exc:  # noqa: BLE001 — поток не должен обрываться молча
            # Сообщение пользователя убираем, чтобы не ломать историю неотвеченной репликой.
            if session["messages"] and session["messages"][-1]["content"] == text:
                session["messages"].pop()
            message = str(exc) if isinstance(exc, llm.LLMError) else f"Внутренняя ошибка: {exc.__class__.__name__}"
            yield _sse("error", message=message)
            return

        answer = "".join(collected).strip()
        if answer:
            session["messages"].append({"role": "assistant", "content": answer})
            session["messages"] = _trim(session["messages"])
        yield _sse("done", session_id=session_id)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/summary")
async def summary(request: SessionRequest, http: Request):
    _check_rate(http)
    session = _SESSIONS.get(request.session_id or "")
    messages = (session or {}).get("messages", [])
    user_turns = [m for m in messages if m["role"] == "user"]
    if len(user_turns) < 2:
        raise HTTPException(
            status_code=422,
            detail="Для итога нужно хотя бы пару реплик. Расскажите ещё немного.",
        )

    transcript = "\n".join(
        f"{'Человек' if m['role'] == 'user' else 'Собеседник'}: {m['content']}" for m in messages
    )
    try:
        text = await llm.complete(
            [
                {"role": "system", "content": SUMMARY_PROMPT},
                {"role": "user", "content": transcript},
            ]
        )
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    if not text:
        raise HTTPException(status_code=502, detail="Модель вернула пустой ответ.")
    return {"summary": text}


@app.post("/api/reset")
async def reset(request: ResetRequest):
    if request.session_id:
        _SESSIONS.pop(request.session_id, None)
    new_id = uuid.uuid4().hex
    _SESSIONS[new_id] = {"messages": [], "touched": time.time()}
    return {"session_id": new_id}


@app.get("/api/health")
async def health():
    provider = llm.provider()
    model = llm.model_name()
    info = {
        "provider": provider,
        "model": model,
        "status": "down",
        # "yes" | "no" | "unknown" — не каждый сервис говорит заранее, есть ли модель
        "model_status": "unknown",
        "fallback": config.LLM_FALLBACK == "demo",
    }
    try:
        models = await llm.list_models()
    except llm.LLMError as exc:
        info["detail"] = str(exc)
        return JSONResponse(info, status_code=503)

    info["status"] = "up"
    exists = await llm.model_exists(model)
    info["model_status"] = {True: "yes", False: "no"}.get(exists, "unknown")
    if exists is False:
        info["models"] = models[:40]
    return info


# --------------------------------------------------------------------------- страницы


@app.get("/")
async def landing():
    return FileResponse(config.FRONTEND_DIR / "index.html")


@app.get("/app")
async def chat_page():
    return FileResponse(config.FRONTEND_DIR / "app.html")


app.mount("/static", StaticFiles(directory=config.FRONTEND_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, reload=True)
