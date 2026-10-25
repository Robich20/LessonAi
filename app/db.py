import sqlite3
from contextlib import contextmanager

from config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#6c8cff',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
    title TEXT,
    source TEXT NOT NULL DEFAULT 'record',          -- record | upload
    status TEXT NOT NULL DEFAULT 'recording',       -- recording | queued | processing | done | error
    progress TEXT,
    error TEXT,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    duration_sec REAL,
    interruptions INTEGER NOT NULL DEFAULT 0,
    transcript TEXT,
    transcript_uk TEXT,
    analysis TEXT,                                  -- JSON produced by the LLM
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lessons_subject ON lessons(subject_id, recorded_at);

CREATE TABLE IF NOT EXISTS homework (
    id INTEGER PRIMARY KEY,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
    task TEXT NOT NULL,
    task_pl TEXT,
    due TEXT,
    due_text TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(
    content,
    lesson_id UNINDEXED,
    subject_id UNINDEXED,
    lang UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init():
    with tx() as c:
        c.executescript(SCHEMA)
        # Crash recovery: anything that was mid-processing goes back to the queue.
        c.execute("UPDATE lessons SET status='queued', progress=NULL WHERE status='processing'")


def one(sql: str, *args):
    with tx() as c:
        row = c.execute(sql, args).fetchone()
        return dict(row) if row else None


def all_(sql: str, *args):
    with tx() as c:
        return [dict(r) for r in c.execute(sql, args).fetchall()]


def run(sql: str, *args) -> int:
    with tx() as c:
        cur = c.execute(sql, args)
        return cur.lastrowid
