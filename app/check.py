"""Проверка связи с моделью одной командой:

    python -m app.check

Покажет провайдера и модель, отправит короткую реплику и напечатает ответ
по мере того, как он приходит. Удобно проверить ключ Groq перед презентацией.
"""

import asyncio
import sys
import time

from . import config, llm
from .prompts import SYSTEM_PROMPT


async def main() -> int:
    print(f"Провайдер: {llm.provider()}")
    print(f"Модель:    {llm.model_name()}")
    if llm.provider() in ("groq", "openai"):
        key = config.LLM_API_KEY
        print(f"Адрес:     {config.LLM_BASE_URL}")
        print(f"Ключ:      {key[:4] + '…' + key[-4:] if len(key) > 12 else 'не задан'}")
    if config.LLM_PROXY:
        print(f"Прокси:    {config.LLM_PROXY}")
    print()

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "Привет. Сегодня был тяжёлый день, немного тревожно."},
    ]
    started = time.perf_counter()
    first = None
    try:
        async for piece in llm.stream_chat(messages):
            if first is None:
                first = time.perf_counter() - started
            print(piece, end="", flush=True)
    except llm.LLMError as exc:
        print(f"✗ {exc}")
        return 1

    total = time.perf_counter() - started
    print(f"\n\n✓ Работает. Первое слово через {first or 0:.1f} с, весь ответ за {total:.1f} с.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
