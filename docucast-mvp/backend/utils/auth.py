"""SQLite-backed auth helpers for DocuCast MVP."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Optional


DB_PATH = Path(os.getenv("DOCUCAST_DB_PATH", Path(__file__).resolve().parents[1] / "docucast.db"))
PBKDF2_ITERATIONS = 210_000


def _normalize_username(username: str) -> str:
    return username.strip()


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with get_connection() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS episodes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                filename TEXT NOT NULL,
                doc_type TEXT NOT NULL DEFAULT '',
                mode TEXT NOT NULL DEFAULT '',
                length TEXT NOT NULL DEFAULT '',
                tone TEXT NOT NULL DEFAULT '',
                audience TEXT NOT NULL DEFAULT '',
                focus TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL DEFAULT '',
                audio_engine TEXT,
                audio_mime TEXT,
                script TEXT NOT NULL,
                audio_base64 TEXT,
                analysis_json TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_episodes_user ON episodes(user_id, created_at DESC);
            """
        )


def _password_hash(password: str, salt: bytes) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return digest.hex()


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt_bytes = salt or secrets.token_bytes(16)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt_bytes.hex()}${_password_hash(password, salt_bytes)}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        algorithm, iterations, salt_hex, expected_hash = password_hash.split("$")
    except ValueError as exc:
        raise ValueError("Invalid password hash stored in database.") from exc

    if algorithm != "pbkdf2_sha256":
        raise ValueError("Unsupported password hash algorithm.")

    salt = bytes.fromhex(salt_hex)
    actual_hash = _password_hash(password, salt)
    return secrets.compare_digest(actual_hash, expected_hash)


def ensure_user(username: str, password: str) -> None:
    username = _normalize_username(username)
    if not username:
        return

    with get_connection() as connection:
        row = connection.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if row is not None:
            return
        connection.execute(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
            (username, hash_password(password), int(time.time())),
        )


def authenticate_user(username: str, password: str) -> bool:
    with get_connection() as connection:
        row = connection.execute(
            "SELECT password_hash FROM users WHERE username = ?",
            (_normalize_username(username),),
        ).fetchone()

    if row is None:
        return False
    return verify_password(password, row["password_hash"])


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(username: str, ttl_seconds: int) -> str:
    token = secrets.token_urlsafe(48)
    now = int(time.time())
    expires_at = now + ttl_seconds

    with get_connection() as connection:
        row = connection.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if row is None:
            raise ValueError("Unknown user.")
        connection.execute(
            """
            INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_used_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (row["id"], _token_hash(token), now, expires_at, now),
        )
    return token


def register_user(username: str, password: str) -> None:
    username = _normalize_username(username)
    if not username:
        raise ValueError("Username is required.")
    if len(username) < 3:
        raise ValueError("Username must be at least 3 characters long.")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters long.")

    with get_connection() as connection:
        existing = connection.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if existing is not None:
            raise ValueError("That username is already taken.")

        try:
            connection.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                (username, hash_password(password), int(time.time())),
            )
        except sqlite3.IntegrityError as exc:
            # Concurrent registration with the same username hit the UNIQUE constraint.
            raise ValueError("That username is already taken.") from exc


def verify_session(token: str) -> str:
    now = int(time.time())
    token_digest = _token_hash(token)

    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT sessions.id AS session_id, sessions.expires_at, users.username
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ?
            """,
            (token_digest,),
        ).fetchone()

        if row is None:
            raise ValueError("Invalid authentication token.")

        if row["expires_at"] < now:
            connection.execute("DELETE FROM sessions WHERE id = ?", (row["session_id"],))
            raise ValueError("Authentication token has expired.")

        connection.execute(
            "UPDATE sessions SET last_used_at = ? WHERE id = ?",
            (now, row["session_id"]),
        )

    return row["username"]


def revoke_session(token: str) -> None:
    token_digest = _token_hash(token)
    with get_connection() as connection:
        connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_digest,))


# ---------------------------------------------------------------------------
# Episodes (saved podcast generations, one row per /generate call)
# ---------------------------------------------------------------------------

def _resolve_user_id(connection: sqlite3.Connection, username: str) -> int:
    row = connection.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
    if row is None:
        raise ValueError("Unknown user.")
    return row["id"]


def save_episode(username: str, episode: dict) -> int:
    """Persist one generated episode, returning its id.

    `episode` keys: filename, doc_type, mode, length, tone, audience, focus,
    provider, audio_engine, audio_mime, script, audio_base64, analysis_json.
    """
    with get_connection() as connection:
        user_id = _resolve_user_id(connection, username)
        cursor = connection.execute(
            """
            INSERT INTO episodes (
                user_id, filename, doc_type, mode, length, tone, audience, focus,
                provider, audio_engine, audio_mime, script, audio_base64,
                analysis_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                episode.get("filename", ""),
                episode.get("doc_type", ""),
                episode.get("mode", ""),
                episode.get("length", ""),
                episode.get("tone", ""),
                episode.get("audience", ""),
                episode.get("focus", ""),
                episode.get("provider", ""),
                episode.get("audio_engine"),
                episode.get("audio_mime"),
                episode.get("script", ""),
                episode.get("audio_base64"),
                episode.get("analysis_json"),
                int(time.time()),
            ),
        )
        return cursor.lastrowid


def list_episodes(username: str, limit: int = 50) -> list:
    """Return the user's episodes, newest first, WITHOUT audio blobs."""
    with get_connection() as connection:
        user_id = _resolve_user_id(connection, username)
        rows = connection.execute(
            """
            SELECT id, filename, doc_type, mode, length, tone, audience, focus,
                   provider, audio_engine, audio_mime, script, analysis_json, created_at
            FROM episodes WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()
    episodes = []
    for r in rows:
        episodes.append({
            "id": r["id"],
            "filename": r["filename"],
            "doc_type": r["doc_type"],
            "options": {
                "mode": r["mode"],
                "length": r["length"],
                "tone": r["tone"],
                "audience": r["audience"],
                "focus": r["focus"],
            },
            "provider": r["provider"],
            "audio_engine": r["audio_engine"],
            "audio_mime": r["audio_mime"],
            "script": r["script"],
            "analysis": json.loads(r["analysis_json"]) if r["analysis_json"] else None,
            "created_at": r["created_at"],
        })
    return episodes


def get_episode(username: str, episode_id: int) -> Optional[dict]:
    """Fetch one episode (including audio) if it belongs to the user."""
    with get_connection() as connection:
        user_id = _resolve_user_id(connection, username)
        row = connection.execute(
            "SELECT * FROM episodes WHERE id = ? AND user_id = ?",
            (episode_id, user_id),
        ).fetchone()
    if row is None:
        return None
    return {
        "id": row["id"],
        "filename": row["filename"],
        "doc_type": row["doc_type"],
        "options": {
            "mode": row["mode"],
            "length": row["length"],
            "tone": row["tone"],
            "audience": row["audience"],
            "focus": row["focus"],
        },
        "provider": row["provider"],
        "audio_engine": row["audio_engine"],
        "audio_mime": row["audio_mime"],
        "script": row["script"],
        "audio_base64": row["audio_base64"],
        "analysis": json.loads(row["analysis_json"]) if row["analysis_json"] else None,
        "created_at": row["created_at"],
    }


def delete_episode(username: str, episode_id: int) -> bool:
    """Delete one of the user's episodes. Returns True if a row was removed."""
    with get_connection() as connection:
        user_id = _resolve_user_id(connection, username)
        cursor = connection.execute(
            "DELETE FROM episodes WHERE id = ? AND user_id = ?",
            (episode_id, user_id),
        )
        return cursor.rowcount > 0

