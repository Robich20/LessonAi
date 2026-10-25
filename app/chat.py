"""Per-subject Q&A over lesson summaries and transcripts (keyword retrieval with SQLite FTS5)."""
import json
import logging
import re
from datetime import datetime
from zoneinfo import ZoneInfo

import config
import db
import llm
import prompts
from worker import local_dt

log = logging.getLogger("chat")


def _fts_query(terms: list[str]) -> str:
    words = set()
    for term in terms:
        for w in re.findall(r"\w+", str(term).lower()):
            if len(w) < 3 or w.isdigit():
                continue
            # Polish/Ukrainian inflect heavily: match on a stem-ish prefix.
            words.add(w[: max(4, len(w) - 2)] + "*" if len(w) > 5 else w)
    return " OR ".join(sorted(words))


def _search(subject_id: int, question: str, subject_name: str) -> list[dict]:
    terms = [question]
    try:
        raw = llm.chat([{"role": "user", "content": prompts.SEARCH_TERMS.format(subject=subject_name, question=question)}],
                       json_mode=True, max_tokens=400, temperature=0)
        data = llm.parse_json(raw)
        terms += list(data.get("pl", [])) + list(data.get("uk", []))
    except Exception:  # noqa: BLE001 - search terms are a nice-to-have
        log.warning("search term expansion failed", exc_info=True)
    q = _fts_query(terms)
    if not q:
        return []
    try:
        return db.all_(
            """SELECT p.content, p.lesson_id, p.lang, l.title, l.recorded_at
               FROM passages p JOIN lessons l ON l.id = p.lesson_id
               WHERE passages MATCH ? AND p.subject_id = ?
               ORDER BY bm25(passages) LIMIT 8""",
            q, subject_id,
        )
    except Exception:  # noqa: BLE001 - malformed query should not kill the chat
        log.warning("fts query failed: %s", q, exc_info=True)
        return []


def _lessons_block(subject_id: int, budget: int = 30000) -> str:
    rows = db.all_("SELECT id, title, recorded_at, analysis FROM lessons WHERE subject_id=? AND analysis IS NOT NULL "
                   "ORDER BY recorded_at DESC", subject_id)
    out, used = [], 0
    for r in rows:
        a = json.loads(r["analysis"])
        hw = "; ".join(h.get("task", "") for h in a.get("homework", []) if isinstance(h, dict))
        block = (f"--- Урок від {local_dt(r['recorded_at']):%Y-%m-%d} «{r['title'] or a.get('title', '')}» ---\n"
                 f"{a.get('summary', '')}\nТези: " + "; ".join(map(str, a.get("key_points", []))) +
                 (f"\nДомашнє: {hw}" if hw else ""))
        if used + len(block) > budget:
            out.append(f"(ще {len(rows) - len(out)} старіших уроків не показано)")
            break
        out.append(block)
        used += len(block)
    return "\n\n".join(out) or "(уроків ще немає)"


def answer(subject_id: int, lesson_id: int | None, question: str) -> str:
    subject = db.one("SELECT name FROM subjects WHERE id=?", subject_id)
    if not subject:
        raise ValueError("Предмет не знайдено")
    passages = _search(subject_id, question, subject["name"])
    passages_txt = "\n\n".join(
        f"[урок від {local_dt(p['recorded_at']):%Y-%m-%d} «{p['title'] or ''}», {'оригінал' if p['lang'] == 'pl' else 'переклад'}]\n{p['content']}"
        for p in passages) or "(нічого не знайдено)"

    focus = ""
    if lesson_id:
        les = db.one("SELECT title, recorded_at, transcript, transcript_uk FROM lessons WHERE id=?", lesson_id)
        if les:
            text = (les["transcript_uk"] or les["transcript"] or "")[:60000]
            focus = (f"\n=== Учень зараз дивиться урок від {local_dt(les['recorded_at']):%Y-%m-%d} «{les['title'] or ''}». "
                     f"Повний транскрипт цього уроку ===\n{text}")

    system = prompts.CHAT_SYSTEM.format(
        subject=subject["name"], today=datetime.now(ZoneInfo(config.TIMEZONE)).strftime("%Y-%m-%d"),
        lessons=_lessons_block(subject_id), passages=passages_txt, focus=focus)
    history = db.all_(
        "SELECT role, content FROM (SELECT * FROM chat_messages WHERE subject_id=? AND lesson_id IS ? "
        "ORDER BY id DESC LIMIT 12) ORDER BY id", subject_id, lesson_id)
    messages = [{"role": "system", "content": system}] + history + [{"role": "user", "content": question}]
    reply = llm.chat(messages, model=config.CHAT_MODEL, temperature=0.3, max_tokens=4000).strip()

    with db.tx() as c:
        c.execute("INSERT INTO chat_messages(subject_id, lesson_id, role, content) VALUES (?,?,?,?)",
                  (subject_id, lesson_id, "user", question))
        c.execute("INSERT INTO chat_messages(subject_id, lesson_id, role, content) VALUES (?,?,?,?)",
                  (subject_id, lesson_id, "assistant", reply))
    return reply
