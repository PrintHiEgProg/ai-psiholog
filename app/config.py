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

# --- Провайдер модели ---
# groq | openai | ollama | demo. Пусто — groq, если есть ключ, иначе ollama.
_PRESETS = {
    "groq": ("https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
    "openai": ("https://openrouter.ai/api/v1", ""),  # модель укажите в LLM_MODEL
}

GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "").strip()
LLM_API_KEY: str = os.getenv("LLM_API_KEY", "").strip() or GROQ_API_KEY

LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "").strip().lower() or ("groq" if GROQ_API_KEY else "ollama")
if LLM_PROVIDER not in ("groq", "openai", "ollama", "demo"):
    raise SystemExit(f"LLM_PROVIDER={LLM_PROVIDER!r}: допустимо groq, openai, ollama или demo")

_base, _model = _PRESETS.get(LLM_PROVIDER, ("", ""))
LLM_BASE_URL: str = (os.getenv("LLM_BASE_URL", "").strip() or _base).rstrip("/")
LLM_MODEL: str = os.getenv("LLM_MODEL", "").strip() or _model
LLM_TIMEOUT: float = float(os.getenv("LLM_TIMEOUT", "60"))
LLM_PROXY: str = os.getenv("LLM_PROXY", "").strip()
# demo — если облако не ответило, продолжить на заготовках вместо ошибки
LLM_FALLBACK: str = os.getenv("LLM_FALLBACK", "").strip().lower()

# --- Ollama ---
OLLAMA_URL: str = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "gemma4:31b-cloud")
OLLAMA_TIMEOUT: float = float(os.getenv("OLLAMA_TIMEOUT", "180"))

# --- Генерация ---
TEMPERATURE: float = float(os.getenv("TEMPERATURE", "0.75"))
TOP_P: float = float(os.getenv("TOP_P", "0.9"))
NUM_PREDICT: int = int(os.getenv("NUM_PREDICT", "400"))

# --- Диалог ---
MAX_HISTORY_MESSAGES: int = int(os.getenv("MAX_HISTORY_MESSAGES", "24"))
SESSION_TTL_SECONDS: int = int(os.getenv("SESSION_TTL_SECONDS", str(60 * 60 * 6)))
MAX_MESSAGE_CHARS: int = int(os.getenv("MAX_MESSAGE_CHARS", "4000"))

# --- Защита ---
RATE_LIMIT_PER_MINUTE: int = int(os.getenv("RATE_LIMIT_PER_MINUTE", "30"))

# --- Сервер ---
HOST: str = os.getenv("HOST", "127.0.0.1")
PORT: int = int(os.getenv("PORT", "8000"))
