"""Turning uploaded/recorded pieces into something we can transcribe and play back."""
import json
import logging
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("audio")


def _run(args):
    p = subprocess.run(args, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"ffmpeg: {p.stderr[-800:]}")
    return p


def duration(path: Path) -> float:
    p = _run(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(path)])
    try:
        return float(json.loads(p.stdout)["format"]["duration"])
    except (KeyError, ValueError):
        return 0.0


def assemble_segments(lesson_dir: Path) -> list[Path]:
    """Recorded lessons arrive as segments (one per MediaRecorder session), each split into
    numbered chunks. Concatenating the chunks of a segment yields a valid (fragmented) file."""
    out = []
    # Only the chunk folders (seg0, seg1, ...); a failed earlier run leaves assembled seg0.m4a files next to them.
    seg_dirs = [p for p in lesson_dir.glob("seg*") if p.is_dir() and p.name[3:].isdigit()]
    for seg_dir in sorted(seg_dirs, key=lambda p: int(p.name[3:])):
        parts = sorted(seg_dir.glob("*.part"), key=lambda p: int(p.stem))
        if not parts:
            continue
        ext = (seg_dir / "ext").read_text().strip() if (seg_dir / "ext").exists() else "bin"
        target = lesson_dir / f"{seg_dir.name}.{ext}"
        with open(target, "wb") as f:
            for part in parts:
                f.write(part.read_bytes())
        out.append(target)
    return out


def prepare(sources: list[Path], work: Path, chunk_seconds: int) -> tuple[Path, Path, list[Path], float]:
    """Returns (wav16k, playback m4a, transcription chunks, duration)."""
    work.mkdir(parents=True, exist_ok=True)
    wavs = []
    for i, src in enumerate(sources):
        wav = work / f"part{i:03d}.wav"
        # Tolerate a truncated tail (phone died / tab killed mid-chunk): decode what we can.
        p = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-err_detect", "ignore_err", "-i", str(src),
             "-vn", "-ac", "1", "-ar", "16000", str(wav)],
            capture_output=True, text=True,
        )
        if wav.exists() and wav.stat().st_size > 10_000:
            wavs.append(wav)
        else:
            log.warning("skipping undecodable piece %s: %s", src.name, p.stderr[-300:])
    if not wavs:
        raise RuntimeError("Не вдалося декодувати жодного аудіо (файл порожній або пошкоджений)")

    full = work / "full.wav"
    if len(wavs) == 1:
        shutil.move(wavs[0], full)
    else:
        listfile = work / "concat.txt"
        listfile.write_text("".join(f"file '{w.name}'\n" for w in wavs))
        _run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listfile), "-c", "copy", str(full)])
        for w in wavs:
            w.unlink(missing_ok=True)

    playback = work.parent / "audio.m4a"
    _run(["ffmpeg", "-y", "-v", "error", "-i", str(full), "-c:a", "aac", "-b:a", "48k", "-movflags", "+faststart", str(playback)])

    chunk_dir = work / "chunks"
    if chunk_dir.exists():
        shutil.rmtree(chunk_dir)
    chunk_dir.mkdir()
    _run(["ffmpeg", "-y", "-v", "error", "-i", str(full), "-f", "segment", "-segment_time", str(chunk_seconds),
          "-c:a", "libmp3lame", "-b:a", "32k", str(chunk_dir / "c%03d.mp3")])
    chunks = sorted(chunk_dir.glob("c*.mp3"))
    return full, playback, chunks, duration(full)
