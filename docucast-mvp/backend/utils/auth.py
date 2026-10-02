"""MongoDB-backed auth and data persistence for DocuCast.

Replaces SQLite with MongoDB (PyMongo), storing users, sessions, episodes,
chat messages, and playlists in actual MongoDB collections inspectable via
MongoDB Compass.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import smtplib
import time
from email.message import EmailMessage
from typing import Any, Optional

from bson import ObjectId
from bson.errors import InvalidId
import pymongo
import gridfs
from pymongo import MongoClient
from pymongo.database import Database

PBKDF2_ITERATIONS = 210_000

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "docucast")

_client: Optional[MongoClient] = None
_db: Optional[Database] = None


def get_db() -> Database:
    """Return the active MongoDB database connection, initializing if needed."""
    global _client, _db
    if _db is None:
        _client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
        _db = _client[MONGODB_DB_NAME]
    return _db


def _normalize_username(username: str) -> str:
    return username.strip()


def _safe_object_id(id_val: Any) -> Optional[ObjectId]:
    if isinstance(id_val, ObjectId):
        return id_val
    try:
        return ObjectId(str(id_val))
    except (InvalidId, TypeError, ValueError):
        return None


def _safe_create_index(col, *args, **kwargs) -> None:
    try:
        col.create_index(*args, **kwargs)
    except pymongo.errors.OperationFailure as exc:
        if exc.code == 85:  # IndexOptionsConflict
            pass
        else:
            raise


def initialize_database() -> None:
    """Ensure indexes on all MongoDB collections and migrate legacy records."""
    db = get_db()
    
    # Drop conflicting legacy indexes that may cause duplicate key errors
    try:
        db.users.drop_index("email_1")
    except pymongo.errors.OperationFailure:
        pass  # Index doesn't exist, that's fine
    try:
        db.users.create_index([("email", pymongo.ASCENDING)], sparse=True)
    except pymongo.errors.OperationFailure:
        pass
    try:
        db.password_reset_tokens.create_index([("expires_at", pymongo.ASCENDING)], expireAfterSeconds=0)
        db.password_reset_tokens.create_index([("token_hash", pymongo.ASCENDING)], unique=True)
    except pymongo.errors.OperationFailure:
        pass
    try:
        db.sessions.drop_index("token_1")
    except pymongo.errors.OperationFailure:
        pass  # Index doesn't exist, that's fine
    
    # Migrate any legacy user documents where username is missing
    for doc in db.users.find({"username": None}):
        candidate = doc.get("email") or doc.get("name") or str(doc["_id"])
        db.users.update_one({"_id": doc["_id"]}, {"$set": {"username": candidate}})

    # Migrate any legacy sessions where token_hash is missing
    for doc in db.sessions.find({"token_hash": None}):
        if doc.get("token"):
            db.sessions.update_one({"_id": doc["_id"]}, {"$set": {"token_hash": _token_hash(doc["token"])}})
        else:
            db.sessions.delete_one({"_id": doc["_id"]})

    # Users: unique username
    _safe_create_index(db.users, [("username", pymongo.ASCENDING)], unique=True)
    # Sessions: fast token lookup and auto-cleanup
    _safe_create_index(db.sessions, [("token_hash", pymongo.ASCENDING)], unique=True)
    _safe_create_index(db.sessions, [("expires_at", pymongo.ASCENDING)], expireAfterSeconds=0)
    # Episodes: per-user list sorted newest-first
    _safe_create_index(db.episodes, [("username", pymongo.ASCENDING), ("created_at", pymongo.DESCENDING)])
    # Chat messages: lookup by episode_id
    _safe_create_index(db.chat_messages, [("episode_id", pymongo.ASCENDING), ("created_at", pymongo.ASCENDING)])
    # Playlists: per-user list sorted newest-first
    _safe_create_index(db.playlists, [("username", pymongo.ASCENDING), ("created_at", pymongo.DESCENDING)])


# ---------------------------------------------------------------------------
# Password hashing & verification
# ---------------------------------------------------------------------------

def _password_hash(password: str, salt: bytes) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return digest.hex()


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    salt_bytes = salt or secrets.token_bytes(16)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt_bytes.hex()}${_password_hash(password, salt_bytes)}"


def verify_password(password: str, password_hash: str) -> bool:
    if not password_hash:
        return False

    # Check bcrypt (legacy or standard bcrypt hashes starting with $2a$ or $2b$)
    if password_hash.startswith("$2a$") or password_hash.startswith("$2b$") or password_hash.startswith("$2y$"):
        try:
            import bcrypt
            return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
        except Exception:
            return False

    try:
        algorithm, iterations, salt_hex, expected_hash = password_hash.split("$")
    except ValueError as exc:
        raise ValueError("Invalid password hash stored in database.") from exc

    if algorithm != "pbkdf2_sha256":
        raise ValueError("Unsupported password hash algorithm.")

    salt = bytes.fromhex(salt_hex)
    actual_hash = _password_hash(password, salt)
    return secrets.compare_digest(actual_hash, expected_hash)


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

def ensure_user(username: str, password: str) -> None:
    """Create default user if not already present."""
    username = _normalize_username(username)
    if not username:
        return
    db = get_db()
    existing = db.users.find_one({"username": username})
    if existing is not None:
        return
    db.users.insert_one({
        "username": username,
        "password_hash": hash_password(password),
        "created_at": int(time.time()),
    })


def authenticate_user(username: str, password: str) -> bool:
    """Verify username & password against MongoDB (supports username or email)."""
    db = get_db()
    norm = _normalize_username(username)
    user = db.users.find_one({"$or": [{"username": norm}, {"email": norm}]})
    if user is None:
        return False
    return verify_password(password, user.get("password_hash", ""))


def reset_password(username: str, new_password: str) -> None:
    """Admin escape hatch: set a user's password directly."""
    username = _normalize_username(username)
    if not username:
        raise ValueError("Username is required.")
    if len(new_password) < 6:
        raise ValueError("Password must be at least 6 characters long.")
    db = get_db()
    result = db.users.update_one(
        {"$or": [{"username": username}, {"email": username}]},
        {"$set": {"password_hash": hash_password(new_password)}}
    )
    if result.matched_count == 0:
        raise ValueError("Unknown user.")


def register_user(username: str, password: str) -> None:
    """Register a new user in MongoDB."""
    username = _normalize_username(username)
    if not username:
        raise ValueError("Username is required.")
    if len(username) < 3:
        raise ValueError("Username must be at least 3 characters long.")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters long.")

    db = get_db()
    existing = db.users.find_one({"$or": [{"username": username}, {"email": username}]})
    if existing is not None:
        raise ValueError("That username is already taken.")

    try:
        db.users.insert_one({
            "username": username,
            "password_hash": hash_password(password),
            "created_at": int(time.time()),
        })
    except pymongo.errors.DuplicateKeyError as exc:
        raise ValueError("That username is already taken.") from exc


def register_user_with_email(username: str, email: str, password: str) -> None:
    """Register a user with a normalized recovery email address."""
    username = _normalize_username(username)
    email = (email or "").strip().lower()
    if not email or "@" not in email or len(email) > 254:
        raise ValueError("Enter a valid email address.")
    if not username or len(username) < 3:
        raise ValueError("Username must be at least 3 characters long.")
    if len(password) < 6:
        raise ValueError("Password must be at least 6 characters long.")
    db = get_db()
    if db.users.find_one({"$or": [{"username": username}, {"email": email}]}):
        raise ValueError("That username or email is already registered.")
    try:
        db.users.insert_one({
            "username": username,
            "email": email,
            "password_hash": hash_password(password),
            "created_at": int(time.time()),
        })
    except pymongo.errors.DuplicateKeyError as exc:
        raise ValueError("That username or email is already registered.") from exc


def _send_reset_email(email: str, reset_url: str) -> None:
    """Send reset mail when SMTP is configured; otherwise log a local link."""
    host = os.getenv("SMTP_HOST", "").strip()
    if not host:
        if os.getenv("DOCUCAST_ALLOW_DEV_RESET_LINK", "false").lower() == "true":
            print(f"[docucast] development password reset link: {reset_url}")
        return
    message = EmailMessage()
    message["Subject"] = "Reset your DocuCast password"
    message["From"] = os.getenv("SMTP_FROM", os.getenv("SMTP_USERNAME", "no-reply@localhost"))
    message["To"] = email
    message.set_content(f"Reset your DocuCast password using this link. It expires in 30 minutes:\n\n{reset_url}\n\nIf you did not request this, ignore this email.")
    port = int(os.getenv("SMTP_PORT", "587"))
    with smtplib.SMTP(host, port, timeout=10) as server:
        server.starttls()
        username = os.getenv("SMTP_USERNAME", "")
        password = os.getenv("SMTP_PASSWORD", "")
        if username:
            server.login(username, password)
        server.send_message(message)


def request_password_reset(email: str) -> Optional[str]:
    """Create a one-time hashed reset token and notify the address if registered."""
    normalized = (email or "").strip().lower()
    db = get_db()
    user = db.users.find_one({"email": normalized})
    if user is None:
        return None
    raw_token = secrets.token_urlsafe(32)
    now = int(time.time())
    db.password_reset_tokens.insert_one({
        "user_id": user["_id"],
        "email": normalized,
        "token_hash": _token_hash(raw_token),
        "created_at": now,
        "expires_at": now + 1800,
    })
    frontend = os.getenv("VERCEL_ORIGIN", "http://localhost:5173").rstrip("/")
    _send_reset_email(normalized, f"{frontend}/?reset_token={raw_token}")
    return raw_token


def reset_password_with_token(token: str, new_password: str) -> None:
    """Consume a valid reset token, update the password, and revoke sessions."""
    if len(new_password) < 6:
        raise ValueError("Password must be at least 6 characters long.")
    digest = _token_hash((token or "").strip())
    db = get_db()
    record = db.password_reset_tokens.find_one({"token_hash": digest})
    if record is None or record.get("expires_at", 0) < int(time.time()):
        if record:
            db.password_reset_tokens.delete_one({"_id": record["_id"]})
        raise ValueError("This password reset link is invalid or expired.")
    result = db.users.update_one({"_id": record["user_id"]}, {"$set": {"password_hash": hash_password(new_password)}})
    if result.matched_count == 0:
        raise ValueError("This password reset link is invalid or expired.")
    db.password_reset_tokens.delete_one({"_id": record["_id"]})
    db.sessions.delete_many({"user_id": record["user_id"]})


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(username: str, ttl_seconds: int) -> str:
    """Generate session token and store hash in MongoDB."""
    token = secrets.token_urlsafe(48)
    now = int(time.time())
    expires_at = now + ttl_seconds
    db = get_db()
    norm = _normalize_username(username)

    user = db.users.find_one({"$or": [{"username": norm}, {"email": norm}]})
    if user is None:
        raise ValueError("Unknown user.")

    canonical_username = user.get("username") or norm

    db.sessions.insert_one({
        "user_id": user["_id"],
        "username": canonical_username,
        "token_hash": _token_hash(token),
        "created_at": now,
        "expires_at": expires_at,
        "last_used_at": now,
    })
    return token


def verify_session(token: str) -> str:
    """Validate token from MongoDB, updating last_used_at."""
    now = int(time.time())
    token_digest = _token_hash(token)
    db = get_db()

    session = db.sessions.find_one({"token_hash": token_digest})
    if session is None:
        raise ValueError("Invalid authentication token.")

    if session["expires_at"] < now:
        db.sessions.delete_one({"_id": session["_id"]})
        raise ValueError("Authentication token has expired.")

    db.sessions.update_one(
        {"_id": session["_id"]},
        {"$set": {"last_used_at": now}}
    )
    return session["username"]


def revoke_session(token: str) -> None:
    token_digest = _token_hash(token)
    db = get_db()
    db.sessions.delete_one({"token_hash": token_digest})


# ---------------------------------------------------------------------------
# Episodes
# ---------------------------------------------------------------------------

def save_episode(username: str, episode: dict) -> str:
    """Persist one generated episode in MongoDB, returning its string ID."""
    db = get_db()
    user = db.users.find_one({"username": username})
    user_id = user["_id"] if user else None

    # Normalise analysis & show_notes if passed as json strings
    analysis = episode.get("analysis")
    if isinstance(analysis, str):
        try:
            analysis = json.loads(analysis)
        except Exception:
            analysis = None
    elif not analysis and episode.get("analysis_json"):
        try:
            analysis = json.loads(episode["analysis_json"])
        except Exception:
            analysis = None

    show_notes = episode.get("show_notes")
    if isinstance(show_notes, str):
        try:
            show_notes = json.loads(show_notes)
        except Exception:
            show_notes = None
    elif not show_notes and episode.get("show_notes_json"):
        try:
            show_notes = json.loads(episode["show_notes_json"])
        except Exception:
            show_notes = None

    audio_base64 = episode.get("audio_base64")
    audio_gridfs_id = None
    if audio_base64:
        try:
            audio_bytes = __import__("base64").b64decode(audio_base64)
            bucket = gridfs.GridFSBucket(db, bucket_name="docucast_audio")
            audio_gridfs_id = bucket.upload_from_stream(
                episode.get("filename", "episode") + ".audio",
                audio_bytes,
                metadata={"username": username, "mime": episode.get("audio_mime") or "audio/mpeg"},
            )
        except Exception:
            audio_gridfs_id = None

    doc = {
        "user_id": user_id,
        "username": username,
        "filename": episode.get("filename", ""),
        "doc_type": episode.get("doc_type", ""),
        "mode": episode.get("mode", ""),
        "length": episode.get("length", ""),
        "tone": episode.get("tone", ""),
        "audience": episode.get("audience", ""),
        "focus": episode.get("focus", ""),
        "provider": episode.get("provider", ""),
        "audio_engine": episode.get("audio_engine"),
        "audio_mime": episode.get("audio_mime"),
        "script": episode.get("script", ""),
        "audio_gridfs_id": audio_gridfs_id,
        # Kept only as a compatibility fallback for older deployments if GridFS is unavailable.
        "audio_base64": episode.get("audio_base64") if audio_gridfs_id is None else None,
        "transcript_segments": episode.get("transcript_segments") or [],
        "analysis": analysis,
        "source_text": episode.get("source_text"),
        "show_notes": show_notes,
        "playlist_id": episode.get("playlist_id"),
        "created_at": int(time.time()),
    }
    result = db.episodes.insert_one(doc)
    return str(result.inserted_id)


def get_episode_audio(username: str, episode_id: Any) -> Optional[tuple[bytes, str]]:
    """Read episode audio from GridFS, with legacy base64 fallback."""
    db = get_db()
    obj_id = _safe_object_id(episode_id)
    query = {"username": username, "_id": obj_id} if obj_id else {"username": username, "_id": str(episode_id)}
    doc = db.episodes.find_one(query, projection={"audio_gridfs_id": 1, "audio_base64": 1, "audio_mime": 1})
    if not doc:
        return None
    if doc.get("audio_gridfs_id"):
        try:
            bucket = gridfs.GridFSBucket(db, bucket_name="docucast_audio")
            return bucket.open_download_stream(doc["audio_gridfs_id"]).read(), doc.get("audio_mime") or "audio/mpeg"
        except Exception:
            return None
    if doc.get("audio_base64"):
        return __import__("base64").b64decode(doc["audio_base64"]), doc.get("audio_mime") or "audio/mpeg"
    return None


def list_episodes(username: str, limit: int = 50) -> dict:
    """Return {episodes, stats} for the user without heavy audio blobs."""
    db = get_db()
    cursor = db.episodes.find(
        {"username": username},
        projection={"audio_base64": 0, "source_text": 0}
    ).sort("created_at", pymongo.DESCENDING).limit(limit)

    episodes = []
    for doc in cursor:
        episodes.append({
            "id": str(doc["_id"]),
            "filename": doc.get("filename", ""),
            "doc_type": doc.get("doc_type", ""),
            "options": {
                "mode": doc.get("mode", ""),
                "length": doc.get("length", ""),
                "tone": doc.get("tone", ""),
                "audience": doc.get("audience", ""),
                "focus": doc.get("focus", ""),
            },
            "provider": doc.get("provider", ""),
            "audio_engine": doc.get("audio_engine"),
            "audio_mime": doc.get("audio_mime"),
            "script": doc.get("script", ""),
            "transcript_segments": doc.get("transcript_segments") or [],
            "analysis": doc.get("analysis"),
            "playlist_id": doc.get("playlist_id"),
            "created_at": doc.get("created_at", 0),
        })

    total = db.episodes.count_documents({"username": username})
    seven_days_ago = int(time.time()) - 7 * 86400
    last_7d = db.episodes.count_documents({"username": username, "created_at": {"$gte": seven_days_ago}})
    with_audio = db.episodes.count_documents({
        "username": username,
        "audio_base64": {"$exists": True, "$ne": None, "$ne": ""}
    })

    latest_doc = db.episodes.find_one({"username": username}, sort=[("created_at", pymongo.DESCENDING)])
    latest_at = latest_doc.get("created_at") if latest_doc else None

    # Aggregation for doc types
    pipeline = [
        {"$match": {"username": username, "doc_type": {"$ne": ""}}},
        {"$group": {"_id": "$doc_type", "n": {"$sum": 1}}},
        {"$sort": {"n": -1}}
    ]
    type_counts = {item["_id"]: item["n"] for item in db.episodes.aggregate(pipeline)}

    stats = {
        "total": total,
        "last_7d": last_7d,
        "with_audio": with_audio,
        "latest_at": latest_at,
        "doc_types": type_counts,
    }
    return {"episodes": episodes, "stats": stats}


def get_episode(username: str, episode_id: Any) -> Optional[dict]:
    """Fetch one episode (including audio) if it belongs to the user."""
    db = get_db()
    obj_id = _safe_object_id(episode_id)
    query: dict[str, Any] = {"username": username}
    if obj_id:
        query["_id"] = obj_id
    else:
        query["_id"] = str(episode_id)

    doc = db.episodes.find_one(query)
    if doc is None:
        return None

    return {
        "id": str(doc["_id"]),
        "filename": doc.get("filename", ""),
        "doc_type": doc.get("doc_type", ""),
        "options": {
            "mode": doc.get("mode", ""),
            "length": doc.get("length", ""),
            "tone": doc.get("tone", ""),
            "audience": doc.get("audience", ""),
            "focus": doc.get("focus", ""),
        },
        "provider": doc.get("provider", ""),
        "audio_engine": doc.get("audio_engine"),
        "audio_mime": doc.get("audio_mime"),
        "script": doc.get("script", ""),
        "audio_base64": doc.get("audio_base64"),
        "transcript_segments": doc.get("transcript_segments") or [],
        "analysis": doc.get("analysis"),
        "show_notes": doc.get("show_notes"),
        "playlist_id": doc.get("playlist_id"),
        "created_at": doc.get("created_at", 0),
    }


def delete_episode(username: str, episode_id: Any) -> bool:
    """Delete an episode and its chat messages. Returns True if removed."""
    db = get_db()
    obj_id = _safe_object_id(episode_id)
    query: dict[str, Any] = {"username": username}
    if obj_id:
        query["_id"] = obj_id
    else:
        query["_id"] = str(episode_id)

    result = db.episodes.delete_one(query)
    if result.deleted_count > 0:
        db.chat_messages.delete_many({"episode_id": str(episode_id), "username": username})
        return True
    return False


def update_episode_script(
    username: str,
    episode_id: Any,
    script: str,
    audio_base64: str,
    audio_engine: str,
    audio_mime: str,
    transcript_segments: Optional[list] = None,
) -> None:
    """Overwrite script, audio and optional timestamps."""
    db = get_db()
    obj_id = _safe_object_id(episode_id)
    query: dict[str, Any] = {"username": username}
    if obj_id:
        query["_id"] = obj_id
    else:
        query["_id"] = str(episode_id)

    update_fields: dict[str, Any] = {
        "script": script,
        "audio_base64": audio_base64,
        "audio_engine": audio_engine,
        "audio_mime": audio_mime,
    }
    if transcript_segments is not None:
        update_fields["transcript_segments"] = transcript_segments

    db.episodes.update_one(query, {"$set": update_fields})


def get_episode_source(username: str, episode_id: Any) -> Optional[str]:
    """Return stored source text for regeneration."""
    db = get_db()
    obj_id = _safe_object_id(episode_id)
    query: dict[str, Any] = {"username": username}
    if obj_id:
        query["_id"] = obj_id
    else:
        query["_id"] = str(episode_id)

    doc = db.episodes.find_one(query, projection={"source_text": 1})
    if doc is None:
        return None
    return doc.get("source_text")


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

def add_chat_message(username: str, episode_id: Any, role: str, content: str) -> str:
    """Append one chat turn for the user's episode, returning its string ID."""
    db = get_db()
    obj_id = _safe_object_id(episode_id)
    query: dict[str, Any] = {"username": username}
    if obj_id:
        query["_id"] = obj_id
    else:
        query["_id"] = str(episode_id)

    owns = db.episodes.find_one(query, projection={"_id": 1})
    if owns is None:
        raise ValueError("Episode not found.")

    res = db.chat_messages.insert_one({
        "username": username,
        "episode_id": str(episode_id),
        "role": role,
        "content": content,
        "created_at": int(time.time()),
    })
    return str(res.inserted_id)


def list_chat_messages(username: str, episode_id: Any, limit: int = 100) -> list:
    """Return chat history for one of the user's episodes, oldest first."""
    db = get_db()
    cursor = db.chat_messages.find({
        "username": username,
        "episode_id": str(episode_id),
    }).sort("created_at", pymongo.ASCENDING).limit(limit)

    return [
        {"role": r.get("role", ""), "content": r.get("content", ""), "created_at": r.get("created_at", 0)}
        for r in cursor
    ]


def clear_chat_messages(username: str, episode_id: Any) -> int:
    """Delete the chat history for an episode. Returns count removed."""
    db = get_db()
    res = db.chat_messages.delete_many({
        "username": username,
        "episode_id": str(episode_id),
    })
    return res.deleted_count


# ---------------------------------------------------------------------------
# Playlists (Feature 6: Batch Mode & Playlists)
# ---------------------------------------------------------------------------

def save_playlist(username: str, title: str, description: str = "", episode_ids: Optional[list[str]] = None) -> str:
    """Create a new playlist in MongoDB."""
    db = get_db()
    user = db.users.find_one({"username": username})
    user_id = user["_id"] if user else None

    doc = {
        "user_id": user_id,
        "username": username,
        "title": title.strip() or "Untitled Series",
        "description": description.strip(),
        "episode_ids": episode_ids or [],
        "created_at": int(time.time()),
    }
    result = db.playlists.insert_one(doc)
    return str(result.inserted_id)


def list_playlists(username: str, limit: int = 50) -> list[dict]:
    """List playlists for a user with episode count and total duration estimate."""
    db = get_db()
    cursor = db.playlists.find({"username": username}).sort("created_at", pymongo.DESCENDING).limit(limit)
    playlists = []
    for doc in cursor:
        ep_ids = doc.get("episode_ids", [])
        playlists.append({
            "id": str(doc["_id"]),
            "title": doc.get("title", ""),
            "description": doc.get("description", ""),
            "episode_ids": ep_ids,
            "episode_count": len(ep_ids),
            "created_at": doc.get("created_at", 0),
        })
    return playlists


def get_playlist(username: str, playlist_id: Any) -> Optional[dict]:
    """Get playlist details including resolved episode summaries."""
    db = get_db()
    obj_id = _safe_object_id(playlist_id)
    query: dict[str, Any] = {"username": username}
    if obj_id:
        query["_id"] = obj_id
    else:
        query["_id"] = str(playlist_id)

    doc = db.playlists.find_one(query)
    if doc is None:
        return None

    # Resolve episodes
    ep_ids = doc.get("episode_ids", [])
    resolved_episodes = []
    for ep_id in ep_ids:
        ep = get_episode(username, ep_id)
        if ep:
            resolved_episodes.append(ep)

    return {
        "id": str(doc["_id"]),
        "title": doc.get("title", ""),
        "description": doc.get("description", ""),
        "episode_ids": ep_ids,
        "episodes": resolved_episodes,
        "episode_count": len(resolved_episodes),
        "created_at": doc.get("created_at", 0),
    }


def delete_playlist(username: str, playlist_id: Any) -> bool:
    """Delete a playlist from MongoDB."""
    db = get_db()
    obj_id = _safe_object_id(playlist_id)
    query: dict[str, Any] = {"username": username}
    if obj_id:
        query["_id"] = obj_id
    else:
        query["_id"] = str(playlist_id)

    res = db.playlists.delete_one(query)
    return res.deleted_count > 0


def add_episode_to_playlist(username: str, playlist_id: Any, episode_id: str) -> bool:
    """Add an episode to an existing playlist."""
    db = get_db()
    obj_id = _safe_object_id(playlist_id)
    query: dict[str, Any] = {"username": username}
    if obj_id:
        query["_id"] = obj_id
    else:
        query["_id"] = str(playlist_id)

    res = db.playlists.update_one(query, {"$addToSet": {"episode_ids": str(episode_id)}})
    # Also tag episode
    ep_obj = _safe_object_id(episode_id)
    if ep_obj:
        db.episodes.update_one({"_id": ep_obj}, {"$set": {"playlist_id": str(playlist_id)}})
    return res.modified_count > 0
