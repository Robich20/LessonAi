import hashlib
import os
from pathlib import Path


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def _bool(key: str, default: bool) -> bool:
    return _env(key, "true" if default else "false").lower() in ("1", "true", "yes", "on")


DATA_DIR = Path(_env("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "lessonai.db"
LESSONS_DIR = DATA_DIR / "lessons"

# OpenRouter
OPENROUTER_API_KEY = _env("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = _env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
LLM_MODEL = _env("LLM_MODEL", "google/gemini-2.5-flash")
CHAT_MODEL = _env("CHAT_MODEL") or LLM_MODEL
APP_URL = _env("APP_URL", "http://localhost")

# Transcription: "openrouter" (audio-capable model, no GPU needed) or "local" (faster-whisper in the container)
TRANSCRIBE_PROVIDER = _env("TRANSCRIBE_PROVIDER", "openrouter").lower()
TRANSCRIBE_MODEL = _env("TRANSCRIBE_MODEL", "google/gemini-2.5-flash")
TRANSCRIBE_CHUNK_SECONDS = int(_env("TRANSCRIBE_CHUNK_SECONDS", "600"))
WHISPER_MODEL = _env("WHISPER_MODEL", "medium")
WHISPER_DEVICE = _env("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = _env("WHISPER_COMPUTE_TYPE", "int8")

LESSON_LANGUAGE = _env("LESSON_LANGUAGE", "pl")
TRANSLATE_FULL = _bool("TRANSLATE_FULL", True)
TIMEZONE = _env("TZ", "Europe/Warsaw")

# Auth: a single password for the whole app (it is a personal tool)
APP_PASSWORD = _env("APP_PASSWORD")
SECRET_KEY = _env("SECRET_KEY") or hashlib.sha256(("lessonai:" + APP_PASSWORD).encode()).hexdigest()

DATA_DIR.mkdir(parents=True, exist_ok=True)
LESSONS_DIR.mkdir(parents=True, exist_ok=True)
