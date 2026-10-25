"""Background pipeline: audio -> transcript -> analysis -> translation -> search index."""
import json
import logging
import shutil
import threading
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import audio
import config
import db
import llm
import prompts
import transcribe

log = logging.getLogger("worker")
_wake = threading.Event()
WEEKDAYS = ["понеділок", "вівторок", "середа", "четвер", "пʼятниця", "субота", "неділя"]


def kick():
    _wake.set()


def local_dt(utc_str: str) -> datetime:
    dt = datetime.fromisoformat(utc_str.replace(" ", "T"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(ZoneInfo(config.TIMEZONE))


def split_paragraphs(text: str, limit: int) -> list[str]:
    groups, cur = [], ""
    for para in text.split("\n\n"):
        if cur and len(cur) + len(para) > limit:
            groups.append(cur)
            cur = ""
        cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        groups.append(cur)
    return groups


def _sources(lesson_dir):
    sources = audio.assemble_segments(lesson_dir)
    if not sources:
        sources = sorted(lesson_dir.glob("upload.*"))
    if not sources and (lesson_dir / "audio.m4a").exists():
        sources = [lesson_dir / "audio.m4a"]
    return sources


def analyze(lesson, subject_name, progress):
    progress("AI-аналіз уроку")
    when = local_dt(lesson["recorded_at"])
    raw = llm.chat(
        [{"role": "system", "content": prompts.ANALYZE_SYSTEM},
         {"role": "user", "content": prompts.ANALYZE_USER.format(
             subject=subject_name, date=when.strftime("%Y-%m-%d"), weekday=WEEKDAYS[when.weekday()],
             transcript=lesson["transcript"])}],
        json_mode=True, max_tokens=16000,
    )
    data = llm.parse_json(raw)
    for key in ("key_points", "terms", "homework", "announcements", "review_questions"):
        if not isinstance(data.get(key), list):
            data[key] = []
    return data


def translate(transcript, progress):
    groups = split_paragraphs(transcript, 6000)
    out = []
    for i, g in enumerate(groups):
        progress(f"Переклад українською {i + 1}/{len(groups)}")
        out.append(llm.chat([{"role": "user", "content": prompts.TRANSLATE.format(text=g)}], max_tokens=12000).strip())
    return "\n\n".join(out)


def index(c, lesson):
    c.execute("DELETE FROM passages WHERE lesson_id = ?", (lesson["id"],))
    for lang, text in (("pl", lesson.get("transcript")), ("uk", lesson.get("transcript_uk"))):
        for passage in split_paragraphs(text or "", 1200):
            c.execute("INSERT INTO passages(content, lesson_id, subject_id, lang) VALUES (?,?,?,?)",
                      (passage, lesson["id"], lesson["subject_id"], lang))


def process(lesson_id: int):
    lesson = db.one("SELECT * FROM lessons WHERE id=?", lesson_id)
    subject = db.one("SELECT name FROM subjects WHERE id=?", lesson["subject_id"]) or {"name": "без предмета"}
    lesson_dir = config.LESSONS_DIR / str(lesson_id)

    def progress(msg):
        log.info("lesson %s: %s", lesson_id, msg)
        db.run("UPDATE lessons SET progress=? WHERE id=?", msg, lesson_id)

    if not lesson["transcript"]:
        progress("Підготовка аудіо")
        sources = _sources(lesson_dir)
        if not sources:
            raise RuntimeError("Немає аудіо для цього уроку")
        wav, _playback, chunks, dur = audio.prepare(sources, lesson_dir / "work", config.TRANSCRIBE_CHUNK_SECONDS)
        db.run("UPDATE lessons SET duration_sec=? WHERE id=?", dur, lesson_id)
        text = transcribe.transcribe(wav, chunks, progress)
        db.run("UPDATE lessons SET transcript=? WHERE id=?", text, lesson_id)
        lesson["transcript"] = text
        shutil.rmtree(lesson_dir / "work", ignore_errors=True)

    if not lesson["analysis"]:
        data = analyze(lesson, subject["name"], progress)
        with db.tx() as c:
            c.execute("UPDATE lessons SET analysis=?, title=COALESCE(NULLIF(title,''), ?) WHERE id=?",
                      (json.dumps(data, ensure_ascii=False), data.get("title") or None, lesson_id))
            c.execute("DELETE FROM homework WHERE lesson_id=?", (lesson_id,))
            for hw in data["homework"]:
                if isinstance(hw, dict) and hw.get("task"):
                    c.execute("INSERT INTO homework(lesson_id, subject_id, task, task_pl, due, due_text) VALUES (?,?,?,?,?,?)",
                              (lesson_id, lesson["subject_id"], hw["task"], hw.get("task_pl"), hw.get("due") or None, hw.get("due_text")))

    if config.TRANSLATE_FULL and not lesson["transcript_uk"]:
        uk = translate(lesson["transcript"], progress)
        db.run("UPDATE lessons SET transcript_uk=? WHERE id=?", uk, lesson_id)
        lesson["transcript_uk"] = uk

    with db.tx() as c:
        index(c, lesson)
        c.execute("UPDATE lessons SET status='done', progress=NULL, error=NULL WHERE id=?", (lesson_id,))

    # Raw pieces are no longer needed once the compact playback file exists.
    if (lesson_dir / "audio.m4a").exists():
        for p in list(lesson_dir.glob("seg*")) + list(lesson_dir.glob("upload.*")):
            shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)


def loop():
    while True:
        row = db.one("SELECT id FROM lessons WHERE status='queued' ORDER BY id LIMIT 1")
        if not row:
            _wake.wait(timeout=30)
            _wake.clear()
            continue
        lid = row["id"]
        db.run("UPDATE lessons SET status='processing', error=NULL WHERE id=?", lid)
        try:
            process(lid)
        except Exception as e:  # noqa: BLE001 - surface any failure to the UI
            log.exception("lesson %s failed", lid)
            db.run("UPDATE lessons SET status='error', error=?, progress=NULL WHERE id=?", str(e)[:1000], lid)
            time.sleep(2)


def start():
    threading.Thread(target=loop, daemon=True, name="worker").start()
