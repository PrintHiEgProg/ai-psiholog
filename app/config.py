"""Конфигурация приложения. Все значения переопределяются через .env / переменные окружения."""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"


def _load_dotenv() -> None:
    """Минимальный загрузчик .env, чтобы не тянуть лишнюю зависимость."""
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for raw in env_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()


# Пустая переменная = не задана. Так бывает, когда в панель хостинга
# (Vercel и др.) импортируют .env.example с пустыми полями.
def _str(name: str, default: str = "") -> str:
    return (os.getenv(name) or "").strip() or default


def _num(name: str, default, kind=float):
    raw = _str(name)
    if not raw:
        return default
    try:
        return kind(raw)
    except ValueError:
        raise SystemExit(f"{name}={raw!r}: ожидается число, например {default}") from None


# --- Провайдер модели ---
# groq | openai | ollama | demo. Пусто — groq, если есть ключ, иначе ollama.
_PRESETS = {
    "groq": ("https://api.groq.com/openai/v1", "openai/gpt-oss-120b"),
    "openai": ("https://openrouter.ai/api/v1", ""),  # модель укажите в LLM_MODEL
}

GROQ_API_KEY: str = _str("GROQ_API_KEY")
LLM_API_KEY: str = _str("LLM_API_KEY") or GROQ_API_KEY

LLM_PROVIDER: str = _str("LLM_PROVIDER").lower() or ("groq" if LLM_API_KEY or os.getenv("VERCEL") else "ollama")
if LLM_PROVIDER not in ("groq", "openai", "ollama", "demo"):
    raise SystemExit(f"LLM_PROVIDER={LLM_PROVIDER!r}: допустимо groq, openai, ollama или demo")

_base, _model = _PRESETS.get(LLM_PROVIDER, ("", ""))
LLM_BASE_URL: str = _str("LLM_BASE_URL", _base).rstrip("/")
LLM_MODEL: str = _str("LLM_MODEL", _model)
LLM_TIMEOUT: float = _num("LLM_TIMEOUT", 60)
LLM_PROXY: str = _str("LLM_PROXY")
# demo — если облако не ответило, продолжить на заготовках вместо ошибки
LLM_FALLBACK: str = _str("LLM_FALLBACK").lower()

# --- Ollama ---
OLLAMA_URL: str = _str("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL: str = _str("OLLAMA_MODEL", "gemma4:31b-cloud")
OLLAMA_TIMEOUT: float = _num("OLLAMA_TIMEOUT", 180)

# --- Генерация ---
TEMPERATURE: float = _num("TEMPERATURE", 0.75)
TOP_P: float = _num("TOP_P", 0.9)
NUM_PREDICT: int = _num("NUM_PREDICT", 400, int)

# --- Диалог ---
MAX_HISTORY_MESSAGES: int = _num("MAX_HISTORY_MESSAGES", 24, int)
SESSION_TTL_SECONDS: int = _num("SESSION_TTL_SECONDS", 60 * 60 * 6, int)
MAX_MESSAGE_CHARS: int = _num("MAX_MESSAGE_CHARS", 4000, int)

# --- Защита ---
RATE_LIMIT_PER_MINUTE: int = _num("RATE_LIMIT_PER_MINUTE", 30, int)

# --- Сервер ---
HOST: str = _str("HOST", "127.0.0.1")
PORT: int = _num("PORT", 8000, int)
