# LessonAI

Record a lesson on your phone, and the server turns it into a transcript, notes, homework and a chat over everything
you've recorded for that subject. I built it for myself: lessons are in Polish, explanations come out in Ukrainian.

AI runs through [OpenRouter](https://openrouter.ai). Speech recognition uses `google/gemini-2.5-flash` by default,
local faster-whisper is also supported.

## Features

- in-browser recording (PWA, works in iPhone Safari); audio is uploaded in 15 s chunks, so a dropped connection loses nothing
- upload of an existing audio file
- per lesson: notes in the lesson language, key points, a plain-language explanation, homework with due dates,
  a glossary, review questions, transcript and translation with timestamps
- one homework list across all subjects
- chat per subject or per lesson

## Running

```bash
cp .env.example .env   # OPENROUTER_API_KEY, APP_PASSWORD, APP_URL
docker compose -f docker-compose.local.yml up -d --build
```

Opens on `http://localhost:8000`. The iPhone needs HTTPS (Safari won't give microphone access otherwise):
use a Cloudflare tunnel, Tailscale, or `docker-compose.yml` with Caddy (`DOMAIN` in `.env`).

Prebuilt image: `compose.yaml` pulls `ghcr.io/robich20/lessonai:latest`, built by GitHub Actions.
Deploying with Arcane is described in [DEPLOY_ARCANE.md](DEPLOY_ARCANE.md).

Data (SQLite and audio) is stored in `./data`.

## Configuration

All variables are documented in [.env.example](.env.example). The main ones: `LLM_MODEL`, `CHAT_MODEL`,
`TRANSCRIBE_PROVIDER` (`openrouter` or `local`), `TRANSLATE_FULL`, `LESSON_LANGUAGE`, `TZ`.

## Stack

FastAPI, SQLite (FTS5 for chat search), ffmpeg, vanilla JS.
