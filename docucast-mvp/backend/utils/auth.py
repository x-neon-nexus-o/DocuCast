"""SQLite-backed auth helpers for DocuCast MVP."""

from __future__ import annotations

import hashlib
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

        connection.execute(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
            (username, hash_password(password), int(time.time())),
        )


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

