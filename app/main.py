import hashlib
import hmac
import json
import logging
import re
import shutil
import unicodedata
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import chat
import config
import db
import worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

app = FastAPI(title="LessonAI")
STATIC = Path(__file__).parent / "static"
COOKIE = "lessonai_auth"
TOKEN = hmac.new(config.SECRET_KEY.encode(), b"lessonai-auth-v1", hashlib.sha256).hexdigest()
MIME_EXT = {"audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/webm": "webm",
            "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/wav": "wav"}


@app.on_event("startup")
def startup():
    db.init()
    worker.start()
    if not config.APP_PASSWORD:
        log.warning("APP_PASSWORD is empty: the app is open to anyone who can reach it")


def require_auth(request: Request):
    if not config.APP_PASSWORD:
        return
    if not hmac.compare_digest(request.cookies.get(COOKIE, ""), TOKEN):
        raise HTTPException(401, "Потрібен вхід")


public = APIRouter(prefix="/api")
api = APIRouter(prefix="/api", dependencies=[Depends(require_auth)])


class Login(BaseModel):
    password: str


@public.post("/login")
def login(body: Login, response: Response):
    if config.APP_PASSWORD and not hmac.compare_digest(body.password, config.APP_PASSWORD):
        raise HTTPException(401, "Невірний пароль")
    response.set_cookie(COOKIE, TOKEN, max_age=60 * 60 * 24 * 365, httponly=True, samesite="lax",
                        secure=config.APP_URL.startswith("https"))
    return {"ok": True}


@api.get("/me")
def me():
    return {"ok": True, "transcribe": config.TRANSCRIBE_PROVIDER, "model": config.LLM_MODEL,
            "configured": bool(config.OPENROUTER_API_KEY)}


# ---------- subjects ----------

class SubjectIn(BaseModel):
    name: str | None = None
    color: str | None = None
    position: int | None = None


@api.get("/subjects")
def list_subjects():
    return db.all_("""SELECT s.*, (SELECT COUNT(*) FROM lessons l WHERE l.subject_id=s.id) AS lessons,
                      (SELECT COUNT(*) FROM homework h WHERE h.subject_id=s.id AND h.done=0) AS open_homework
                      FROM subjects s ORDER BY position, name""")


@api.post("/subjects")
def create_subject(body: SubjectIn):
    if not (body.name or "").strip():
        raise HTTPException(400, "Вкажіть назву")
    pos = (db.one("SELECT COALESCE(MAX(position),0)+1 AS p FROM subjects") or {"p": 0})["p"]
    sid = db.run("INSERT INTO subjects(name, color, position) VALUES (?,?,?)", body.name.strip(), body.color or "#6c8cff", pos)
    return db.one("SELECT * FROM subjects WHERE id=?", sid)


@api.patch("/subjects/{sid}")
def update_subject(sid: int, body: SubjectIn):
    for field in ("name", "color", "position"):
        val = getattr(body, field)
        if val is not None:
            db.run(f"UPDATE subjects SET {field}=? WHERE id=?", val, sid)
    return db.one("SELECT * FROM subjects WHERE id=?", sid)


@api.delete("/subjects/{sid}")
def delete_subject(sid: int):
    db.run("DELETE FROM subjects WHERE id=?", sid)
    return {"ok": True}


# ---------- lessons ----------

LIST_FIELDS = """l.id, l.subject_id, l.title, l.source, l.status, l.progress, l.error, l.recorded_at, l.duration_sec,
                 l.interruptions, s.name AS subject_name, s.color AS subject_color,
                 (SELECT COUNT(*) FROM homework h WHERE h.lesson_id=l.id) AS homework_count"""


@api.get("/lessons")
def list_lessons(subject_id: int | None = None, limit: int = 100):
    if subject_id:
        return db.all_(f"SELECT {LIST_FIELDS} FROM lessons l LEFT JOIN subjects s ON s.id=l.subject_id "
                       "WHERE l.subject_id=? ORDER BY l.recorded_at DESC LIMIT ?", subject_id, limit)
    return db.all_(f"SELECT {LIST_FIELDS} FROM lessons l LEFT JOIN subjects s ON s.id=l.subject_id "
                   "ORDER BY l.recorded_at DESC LIMIT ?", limit)


def _lesson_or_404(lid: int):
    row = db.one(f"SELECT l.*, s.name AS subject_name, s.color AS subject_color FROM lessons l "
                 "LEFT JOIN subjects s ON s.id=l.subject_id WHERE l.id=?", lid)
    if not row:
        raise HTTPException(404, "Урок не знайдено")
    return row


@api.get("/lessons/{lid}")
def get_lesson(lid: int):
    row = _lesson_or_404(lid)
    row["analysis"] = json.loads(row["analysis"]) if row["analysis"] else None
    row["homework"] = db.all_("SELECT * FROM homework WHERE lesson_id=? ORDER BY id", lid)
    row["has_audio"] = (config.LESSONS_DIR / str(lid) / "audio.m4a").exists()
    return row


class LessonIn(BaseModel):
    subject_id: int | None = None
    title: str | None = None


@api.post("/lessons")
def create_lesson(body: LessonIn):
    """Start a live recording; audio arrives afterwards as chunks."""
    lid = db.run("INSERT INTO lessons(subject_id, source, status) VALUES (?, 'record', 'recording')", body.subject_id)
    (config.LESSONS_DIR / str(lid)).mkdir(parents=True, exist_ok=True)
    return {"id": lid}


@api.patch("/lessons/{lid}")
def update_lesson(lid: int, body: LessonIn):
    _lesson_or_404(lid)
    if body.title is not None:
        db.run("UPDATE lessons SET title=? WHERE id=?", body.title.strip(), lid)
    if body.subject_id is not None:
        with db.tx() as c:
            c.execute("UPDATE lessons SET subject_id=? WHERE id=?", (body.subject_id, lid))
            c.execute("UPDATE homework SET subject_id=? WHERE lesson_id=?", (body.subject_id, lid))
            c.execute("UPDATE passages SET subject_id=? WHERE lesson_id=?", (body.subject_id, lid))
    return get_lesson(lid)


@api.delete("/lessons/{lid}")
def delete_lesson(lid: int):
    with db.tx() as c:
        c.execute("DELETE FROM passages WHERE lesson_id=?", (lid,))
        c.execute("DELETE FROM lessons WHERE id=?", (lid,))
    shutil.rmtree(config.LESSONS_DIR / str(lid), ignore_errors=True)
    return {"ok": True}


@api.put("/lessons/{lid}/segments/{seq}/chunks/{idx}")
async def put_chunk(lid: int, seq: int, idx: int, request: Request, mime: str = "audio/mp4"):
    lesson = db.one("SELECT status FROM lessons WHERE id=?", lid)
    if not lesson:
        raise HTTPException(404, "Урок не знайдено")
    seg_dir = config.LESSONS_DIR / str(lid) / f"seg{seq}"
    seg_dir.mkdir(parents=True, exist_ok=True)
    base = mime.split(";")[0].strip().lower()
    (seg_dir / "ext").write_text(MIME_EXT.get(base, "bin"))
    data = await request.body()
    tmp = seg_dir / f"{idx}.tmp"
    tmp.write_bytes(data)
    tmp.replace(seg_dir / f"{idx}.part")  # idempotent: re-uploads overwrite
    return {"ok": True, "bytes": len(data)}


class FinishIn(BaseModel):
    interruptions: int = 0


@api.post("/lessons/{lid}/finish")
def finish_lesson(lid: int, body: FinishIn):
    lesson = _lesson_or_404(lid)
    if lesson["status"] == "recording":
        db.run("UPDATE lessons SET status='queued', interruptions=? WHERE id=?", body.interruptions, lid)
        worker.kick()
    return {"ok": True}


@api.post("/lessons/upload")
def upload_lesson(file: UploadFile = File(...), subject_id: int | None = Form(None), recorded_at: str | None = Form(None)):
    ext = re.sub(r"[^a-z0-9]", "", Path(file.filename or "").suffix.lower())[:5] or \
        MIME_EXT.get((file.content_type or "").split(";")[0], "bin")
    lid = db.run("INSERT INTO lessons(subject_id, source, status) VALUES (?, 'upload', 'recording')", subject_id)
    lesson_dir = config.LESSONS_DIR / str(lid)
    lesson_dir.mkdir(parents=True, exist_ok=True)
    with open(lesson_dir / f"upload.{ext}", "wb") as f:
        shutil.copyfileobj(file.file, f, length=1024 * 1024)
    if recorded_at and re.match(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", recorded_at):
        db.run("UPDATE lessons SET recorded_at=? WHERE id=?", recorded_at.replace("T", " ")[:19], lid)
    db.run("UPDATE lessons SET status='queued' WHERE id=?", lid)
    worker.kick()
    return {"id": lid}


@api.post("/lessons/{lid}/retry")
def retry_lesson(lid: int, mode: str = "resume"):
    """resume: continue from the failed step; analysis: redo AI analysis + translation; full: re-transcribe too."""
    _lesson_or_404(lid)
    if mode == "full":
        db.run("UPDATE lessons SET transcript=NULL, transcript_uk=NULL, analysis=NULL, title=NULL WHERE id=?", lid)
    elif mode == "analysis":
        db.run("UPDATE lessons SET transcript_uk=NULL, analysis=NULL, title=NULL WHERE id=?", lid)
    db.run("UPDATE lessons SET status='queued', error=NULL WHERE id=?", lid)
    worker.kick()
    return {"ok": True}


@api.get("/lessons/{lid}/audio")
def lesson_audio(lid: int):
    path = config.LESSONS_DIR / str(lid) / "audio.m4a"
    if not path.exists():
        raise HTTPException(404, "Аудіо ще не готове")
    return FileResponse(path, media_type="audio/mp4")


# ---------- search ----------

def _fold(text: str) -> str:
    """Lowercase and strip accents char by char, so positions in the folded text match the original."""
    return "".join((unicodedata.normalize("NFKD", ch.lower())[:1] or ch) for ch in text).replace("ł", "l")


def _snippet(text: str, words: list[str], width: int = 90) -> str | None:
    folded = _fold(text)
    if not all(w in folded for w in words):
        return None
    pos = min(folded.find(w) for w in words)
    start, end = max(0, pos - width // 3), min(len(text), pos + width)
    spans = sorted((m.start(), m.end()) for w in words for m in re.finditer(re.escape(w), folded[start:end]))
    out, last = [], 0
    for a, b in spans:
        if a < last:
            continue
        out += [text[start + last:start + a], "[[", text[start + a:start + b], "]]"]
        last = b
    out.append(text[start + last:end])
    snip = re.sub(r"\s+", " ", "".join(out)).strip()
    return ("…" if start else "") + snip + ("…" if end < len(text) else "")


@api.get("/search")
def search(q: str, subject_id: int | None = None, limit: int = 30):
    """Find lessons by words in the konspekt/terms (exact substring) and transcripts (FTS, prefix match)."""
    words = [w for w in re.findall(r"\w+", _fold(q)) if len(w) > 1][:8]
    if not words:
        return []
    where, args = ("AND l.subject_id=?", [subject_id]) if subject_id else ("", [])
    hits: dict[int, dict] = {}

    def hit(r):
        return hits.setdefault(r["id"], {"lesson_id": r["id"], "title": r["title"], "recorded_at": r["recorded_at"],
                                         "subject_name": r["subject_name"], "subject_color": r["subject_color"],
                                         "snippets": []})

    for r in db.all_(f"""SELECT l.id, l.title, l.recorded_at, l.analysis, s.name AS subject_name, s.color AS subject_color
                         FROM lessons l LEFT JOIN subjects s ON s.id=l.subject_id
                         WHERE l.analysis IS NOT NULL {where} ORDER BY l.recorded_at DESC""", *args):
        a = json.loads(r["analysis"])
        terms = [f"{t.get('pl', '')} — {t.get('uk', '')}" for t in a.get("terms") or []]
        body = "\n".join([r["title"] or "", a.get("summary") or "", *(a.get("key_points") or []), *terms,
                          a.get("explanation") or ""])
        body = re.sub(r"```mermaid.*?```|[#*>|`]", " ", body, flags=re.S)
        snip = _snippet(body, words)
        if snip:
            hit(r)["snippets"].append({"where": "summary", "text": snip})

    # FTS folds diacritics itself (except ł), so it gets the words as typed.
    fts = " ".join(f'"{w}"*' for w in re.findall(r"\w+", q.lower()) if len(w) > 1)
    try:
        rows = db.all_(f"""SELECT l.id, l.title, l.recorded_at, s.name AS subject_name, s.color AS subject_color, p.lang,
                           snippet(passages, 0, '[[', ']]', '…', 16) AS snip
                           FROM passages p JOIN lessons l ON l.id=p.lesson_id LEFT JOIN subjects s ON s.id=l.subject_id
                           WHERE passages MATCH ? {where} ORDER BY bm25(passages) LIMIT 80""", fts, *args)
    except Exception:  # noqa: BLE001 - odd input must not break the page
        log.warning("search failed: %s", fts, exc_info=True)
        rows = []
    for r in rows:
        h = hit(r)
        if sum(x["where"] != "summary" for x in h["snippets"]) < 2:
            text = re.sub(r"\[\d{1,3}:\d{2}\]\s*", "", r["snip"]).strip()
            h["snippets"].append({"where": r["lang"], "text": text})
    return list(hits.values())[:limit]


# ---------- dashboard ----------

@api.get("/dashboard")
def dashboard():
    week = "datetime('now', '-7 days')"
    stats = db.one(f"""SELECT
        (SELECT COUNT(*) FROM lessons) AS lessons_total,
        (SELECT COUNT(*) FROM lessons WHERE recorded_at >= {week}) AS lessons_week,
        (SELECT COALESCE(SUM(duration_sec), 0) FROM lessons) AS seconds_total,
        (SELECT COALESCE(SUM(duration_sec), 0) FROM lessons WHERE recorded_at >= {week}) AS seconds_week,
        (SELECT COUNT(*) FROM homework WHERE done=0) AS homework_open,
        (SELECT COUNT(*) FROM homework WHERE done=0 AND due < date('now')) AS homework_overdue,
        (SELECT COUNT(*) FROM lessons WHERE status IN ('queued','processing')) AS processing""")
    homework = db.all_("""SELECT h.*, s.name AS subject_name, s.color AS subject_color, l.title AS lesson_title
                          FROM homework h LEFT JOIN subjects s ON s.id=h.subject_id LEFT JOIN lessons l ON l.id=h.lesson_id
                          WHERE h.done=0 ORDER BY h.due IS NULL, h.due, h.id DESC LIMIT 6""")
    announcements = []
    for r in db.all_("""SELECT l.id, l.title, l.recorded_at, l.analysis, s.name AS subject_name, s.color AS subject_color
                        FROM lessons l LEFT JOIN subjects s ON s.id=l.subject_id
                        WHERE l.analysis IS NOT NULL AND l.recorded_at >= datetime('now', '-14 days')
                        ORDER BY l.recorded_at DESC"""):
        for text in json.loads(r["analysis"]).get("announcements", []):
            announcements.append({"text": text, "lesson_id": r["id"], "lesson_title": r["title"], "recorded_at": r["recorded_at"],
                                  "subject_name": r["subject_name"], "subject_color": r["subject_color"]})
    recent = db.all_(f"SELECT {LIST_FIELDS} FROM lessons l LEFT JOIN subjects s ON s.id=l.subject_id "
                     "ORDER BY l.recorded_at DESC LIMIT 6")
    return {"stats": stats, "homework": homework, "announcements": announcements[:8],
            "recent": recent, "subjects": list_subjects()}


# ---------- homework ----------

@api.get("/homework")
def list_homework(include_done: bool = False):
    where = "" if include_done else "WHERE h.done=0"
    return db.all_(f"""SELECT h.*, s.name AS subject_name, s.color AS subject_color, l.title AS lesson_title,
                       l.recorded_at FROM homework h LEFT JOIN subjects s ON s.id=h.subject_id
                       LEFT JOIN lessons l ON l.id=h.lesson_id {where}
                       ORDER BY h.done, h.due IS NULL, h.due, l.recorded_at DESC""")


class HomeworkIn(BaseModel):
    done: bool | None = None
    task: str | None = None
    due: str | None = None


@api.patch("/homework/{hid}")
def update_homework(hid: int, body: HomeworkIn):
    if body.done is not None:
        db.run("UPDATE homework SET done=? WHERE id=?", int(body.done), hid)
    if body.task is not None:
        db.run("UPDATE homework SET task=? WHERE id=?", body.task, hid)
    if body.due is not None:
        db.run("UPDATE homework SET due=? WHERE id=?", body.due or None, hid)
    return db.one("SELECT * FROM homework WHERE id=?", hid)


# ---------- chat ----------

class ChatIn(BaseModel):
    message: str
    lesson_id: int | None = None


@api.get("/subjects/{sid}/chat")
def get_chat(sid: int, lesson_id: int | None = None):
    return db.all_("SELECT id, role, content, created_at FROM chat_messages WHERE subject_id=? AND lesson_id IS ? ORDER BY id",
                   sid, lesson_id)


@api.post("/subjects/{sid}/chat")
async def post_chat(sid: int, body: ChatIn):
    if not body.message.strip():
        raise HTTPException(400, "Порожнє питання")
    try:
        reply = await run_in_threadpool(chat.answer, sid, body.lesson_id, body.message.strip())
    except Exception as e:  # noqa: BLE001
        log.exception("chat failed")
        raise HTTPException(502, f"AI недоступний: {e}") from e
    return {"reply": reply}


@api.delete("/subjects/{sid}/chat")
def clear_chat(sid: int, lesson_id: int | None = None):
    db.run("DELETE FROM chat_messages WHERE subject_id=? AND lesson_id IS ?", sid, lesson_id)
    return {"ok": True}


app.include_router(public)
app.include_router(api)


@app.middleware("http")
async def no_cache_shell(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
