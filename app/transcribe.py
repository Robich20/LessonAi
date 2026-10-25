import base64
import logging
import re
from pathlib import Path

import config
import llm
import prompts

log = logging.getLogger("transcribe")

LANG_NAMES = {"pl": "Polish", "uk": "Ukrainian", "en": "English", "de": "German"}
TS_RE = re.compile(r"^\s*\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]\s*", re.M)


def fmt_ts(seconds: float) -> str:
    s = int(max(0, seconds))
    return f"[{s // 60:02d}:{s % 60:02d}]"


def _shift_timestamps(text: str, offset: float) -> str:
    def repl(m):
        if m.group(3) is not None:  # [HH:MM:SS]
            secs = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        else:
            secs = int(m.group(1)) * 60 + int(m.group(2))
        return fmt_ts(secs + offset) + " "
    out = TS_RE.sub(repl, text.strip())
    out = re.sub(r"\n+(?=\[\d)", "\n\n", out)  # one paragraph per timestamp
    if not TS_RE.match(out):
        out = fmt_ts(offset) + " " + out
    return out


def via_openrouter(chunks: list[Path], chunk_seconds: int, on_progress) -> str:
    language = LANG_NAMES.get(config.LESSON_LANGUAGE, config.LESSON_LANGUAGE)
    parts, tail = [], ""
    for i, chunk in enumerate(chunks):
        on_progress(f"Розпізнавання мовлення {i + 1}/{len(chunks)}")
        ctx = prompts.TRANSCRIBE_CONTEXT.format(tail=tail) if tail else ""
        prompt = prompts.TRANSCRIBE.format(language=language, part=f"{i + 1} of {len(chunks)}", context=ctx)
        audio_b64 = base64.b64encode(chunk.read_bytes()).decode()
        text = llm.chat(
            [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "input_audio", "input_audio": {"data": audio_b64, "format": "mp3"}},
            ]}],
            model=config.TRANSCRIBE_MODEL, temperature=0, max_tokens=16000,
        )
        text = _shift_timestamps(text, i * chunk_seconds)
        parts.append(text)
        tail = re.sub(r"\[[^\]]*\]", "", text)[-300:].strip()
    return "\n\n".join(parts)


_whisper = None


def via_local(wav: Path, on_progress) -> str:
    global _whisper
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError("faster-whisper не встановлено: зберіть образ з LOCAL_WHISPER=true") from e
    if _whisper is None:
        on_progress(f"Завантаження моделі Whisper ({config.WHISPER_MODEL})")
        _whisper = WhisperModel(config.WHISPER_MODEL, device=config.WHISPER_DEVICE,
                                compute_type=config.WHISPER_COMPUTE_TYPE,
                                download_root=str(config.DATA_DIR / "models"))
    segments, info = _whisper.transcribe(str(wav), language=config.LESSON_LANGUAGE, vad_filter=True, beam_size=5)
    paragraphs, cur, cur_start, last_end = [], [], 0.0, 0.0
    for seg in segments:
        # New paragraph on a long pause or every ~45s of speech.
        if cur and (seg.start - last_end > 2.0 or seg.start - cur_start > 45):
            paragraphs.append(fmt_ts(cur_start) + " " + " ".join(cur))
            cur = []
        if not cur:
            cur_start = seg.start
        cur.append(seg.text.strip())
        last_end = seg.end
        if info.duration:
            on_progress(f"Розпізнавання мовлення {int(100 * seg.end / info.duration)}%")
    if cur:
        paragraphs.append(fmt_ts(cur_start) + " " + " ".join(cur))
    return "\n\n".join(paragraphs) or "[00:00] [cisza]"


def transcribe(wav: Path, chunks: list[Path], on_progress) -> str:
    if config.TRANSCRIBE_PROVIDER == "local":
        return via_local(wav, on_progress)
    return via_openrouter(chunks, config.TRANSCRIBE_CHUNK_SECONDS, on_progress)
