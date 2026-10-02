"""FastAPI entrypoint for DocuCast MVP - with free unlimited AI alternatives."""

import base64
import json
import os
import re
import sys
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

# Keep imports working when launched as either `main:app` from backend or
# `backend.main:app` from the repository root.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend.utils.auth import (
    add_chat_message,
    add_episode_to_playlist,
    authenticate_user,
    clear_chat_messages,
    create_session,
    delete_episode,
    delete_playlist,
    ensure_user,
    get_episode,
    get_episode_source,
    get_playlist,
    initialize_database,
    list_chat_messages,
    list_episodes,
    list_playlists,
    register_user,
    register_user_with_email,
    reset_password,
    request_password_reset,
    reset_password_with_token,
    revoke_session,
    save_episode,
    save_playlist,
    update_episode_script,
    verify_session,
)
from backend.utils.document_parser import MAX_IMAGES, SUPPORTED_EXTENSIONS, ParsedDocument, parse_document
from backend.utils.script_generator import (
    DEFAULT_OPTIONS,
    answer_question,
    generate_script_with_provider,
    generate_show_notes,
    get_available_providers,
)
from backend.utils.tts_engine import generate_audio
from backend.utils.url_ingestion import ingest_url, is_youtube_url
from backend.utils.vision import vision_available

load_dotenv()

MAX_FILE_BYTES = 20 * 1024 * 1024  # 20 MB (PPTX decks with images run large)
ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/markdown",
    "text/x-markdown",
    "text/plain",
    "application/octet-stream",  # browsers often send this for .md — extension is validated separately
}

# Simple per-IP in-memory throttle: max N requests within WINDOW seconds.
THROTTLE_MAX_REQUESTS = 5
AUTH_THROTTLE_MAX_REQUESTS = 10
THROTTLE_WINDOW_SECONDS = 60
THROTTLE_MAX_TRACKED_IPS = 10_000
_request_log: dict[str, deque] = defaultdict(deque)

# Set ALLOW_REGISTRATION=false to close open sign-up (the backend proxies your
# LLM API keys, so public deployments should disable it).
ALLOW_REGISTRATION = os.getenv("ALLOW_REGISTRATION", "true").strip().lower() not in {"0", "false", "no"}

# Allowed CORS origins: Vercel deployment (set via env) + localhost for dev.
_prod_origin = os.getenv("VERCEL_ORIGIN", "").strip().rstrip("/")
_dev_origins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
]
# When a production origin is configured, restrict CORS to that + localhost.
# Otherwise (pure dev / preview / tunnel), allow all origins.
if _prod_origin:
    allow_origins = [_prod_origin] + _dev_origins
else:
    allow_origins = ["*"]

AUTH_USERNAME = os.getenv("DOCUCAST_USERNAME", "admin")
AUTH_PASSWORD = os.getenv("DOCUCAST_PASSWORD", "docucast")
AUTH_TOKEN_TTL_SECONDS = int(os.getenv("DOCUCAST_TOKEN_TTL_SECONDS", "43200"))
SUPPORTED_LANGUAGES = {"en", "es", "fr", "de", "it", "pt", "hi", "ja"}


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str


class ResynthesizeRequest(BaseModel):
    script: str


class BriefPreviewRequest(BaseModel):
    url: Optional[str] = None


# ---------------------------------------------------------------------------
# Job system — long-running generation runs in a background thread; the client
# polls /jobs/{id} for REAL stage updates instead of a fake timed sequence.
# ---------------------------------------------------------------------------
JOBS_TTL_SECONDS = 60 * 30          # finished jobs are forgettable after 30 min
JOBS_MAX_TRACKED = 500
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_worker_sem = threading.Semaphore(4)  # cap concurrent pipelines (LLM + TTS are heavy)


def _new_job(kind: str) -> str:
    job_id = uuid.uuid4().hex
    with _jobs_lock:
        # Bound the store: drop finished jobs oldest-first.
        finished = [k for k, v in _jobs.items() if v["status"] in {"done", "error"}]
        while len(_jobs) >= JOBS_MAX_TRACKED and finished:
            _jobs.pop(finished.pop(0))
        _jobs[job_id] = {
            "kind": kind,
            "status": "queued",   # queued | running | done | error
            "stage": "queued",
            "percent": 0,
            "detail": "",
            "result": None,
            "error": None,
            "created": time.time(),
        }
    return job_id


def _job_set(job_id: str, **fields) -> None:
    with _jobs_lock:
        _jobs[job_id].update(fields)


def _job_get(job_id: str) -> Optional[dict]:
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        if time.time() - job["created"] > JOBS_TTL_SECONDS:
            _jobs.pop(job_id, None)
            return None
        return {k: v for k, v in job.items() if k not in {"_fn", "_args"}}


def _run_job(job_id: str, fn) -> None:
    """Run one pipeline job on a worker thread with a concurrency cap.

    `fn` receives a `report(stage, percent)` callback so the pipeline can push
    REAL progress updates the client sees while polling.
    """
    stage_ref = {"stage": "queued"}

    def report(stage: str, percent: int) -> None:
        stage_ref["stage"] = stage
        _job_set(job_id, stage=stage, percent=percent)

    def _target():
        with _worker_sem:
            _job_set(job_id, status="running")
            try:
                result = fn(report)
                _job_set(job_id, status="done", stage="done", percent=100, result=result)
            except HTTPException as exc:
                _job_set(job_id, status="error", stage=stage_ref["stage"], error=str(exc.detail))
            except Exception as exc:
                _job_set(job_id, status="error", stage=stage_ref["stage"], error=f"{type(exc).__name__}: {exc}")

    threading.Thread(target=_target, daemon=True).start()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    initialize_database()
    ensure_user(AUTH_USERNAME, AUTH_PASSWORD)
    # One-shot password reset escape hatch (no email infra in the MVP):
    # start once with DOCUCAST_RESET_USER + DOCUCAST_RESET_PASSWORD to set a
    # new password for a locked-out user, then unset them.
    _reset_user = os.getenv("DOCUCAST_RESET_USER", "").strip()
    _reset_pass = os.getenv("DOCUCAST_RESET_PASSWORD", "").strip()
    if _reset_user and _reset_pass:
        try:
            reset_password(_reset_user, _reset_pass)
            print(f"[docucast] password reset for '{_reset_user}' via DOCUCAST_RESET_* — unset these now.")
        except ValueError as exc:
            print(f"[docucast] password reset failed: {exc}")
    yield


app = FastAPI(title="DocuCast", version="2.0.0", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins if allow_origins != ["*"] else ["*"],
    allow_credentials=True if allow_origins != ["*"] else False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_throttle(ip: str, max_requests: int = THROTTLE_MAX_REQUESTS) -> None:
    now = time.time()
    # Bound tracked IPs so a flood of spoofed addresses can't grow memory forever.
    if ip not in _request_log and len(_request_log) >= THROTTLE_MAX_TRACKED_IPS:
        _request_log.pop(next(iter(_request_log)))
    log = _request_log[ip]
    while log and now - log[0] > THROTTLE_WINDOW_SECONDS:
        log.popleft()
    if len(log) >= max_requests:
        retry_after = int(THROTTLE_WINDOW_SECONDS - (now - log[0])) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Too many requests. Please try again in {retry_after} seconds.",
        )
    log.append(now)


def _parse_selected_pages(value: Optional[str]) -> Optional[list[int]]:
    """Parse page expressions like `1,2,8` and `1-3,8` into page numbers."""
    if not value or not value.strip():
        return None
    pages = set()
    for part in re.split(r"[,\s]+", value.strip()):
        if not part:
            continue
        if "-" in part:
            start_text, end_text = part.split("-", 1)
            if not start_text.isdigit() or not end_text.isdigit():
                raise HTTPException(status_code=400, detail="Pages must look like 1,2,8 or 5-12.")
            start, end = int(start_text), int(end_text)
            if start < 1 or end < start or end - start > 100:
                raise HTTPException(status_code=400, detail="Page range is invalid or too large.")
            pages.update(range(start, end + 1))
        elif part.isdigit() and int(part) > 0:
            pages.add(int(part))
        else:
            raise HTTPException(status_code=400, detail="Pages must look like 1,2,8 or 5-12.")
    if not pages or len(pages) > 100:
        raise HTTPException(status_code=400, detail="Select between 1 and 100 pages.")
    return sorted(pages)


def _require_user(authorization: Optional[str] = Header(default=None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Please log in to continue.")

    token = authorization.removeprefix("Bearer ").strip()
    try:
        username = verify_session(token)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    return username


@app.post("/auth/login")
def login(payload: LoginRequest, request: Request) -> dict:
    _check_throttle(_client_ip(request), max_requests=AUTH_THROTTLE_MAX_REQUESTS)
    if not authenticate_user(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    access_token = create_session(payload.username.strip(), AUTH_TOKEN_TTL_SECONDS)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {"username": payload.username.strip()},
    }


@app.post("/auth/register")
def register(payload: RegisterRequest, request: Request) -> dict:
    if not ALLOW_REGISTRATION:
        raise HTTPException(status_code=403, detail="Registration is disabled on this server.")
    _check_throttle(_client_ip(request), max_requests=AUTH_THROTTLE_MAX_REQUESTS)
    try:
        register_user_with_email(payload.username, payload.email, payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    access_token = create_session(payload.username.strip(), AUTH_TOKEN_TTL_SECONDS)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {"username": payload.username.strip()},
    }


@app.post("/auth/forgot-password")
def forgot_password(payload: ForgotPasswordRequest, request: Request) -> dict:
    """Start reset without revealing whether an email is registered."""
    _check_throttle(_client_ip(request), max_requests=AUTH_THROTTLE_MAX_REQUESTS)
    try:
        token = request_password_reset(payload.email)
        if token and os.getenv("DOCUCAST_ALLOW_DEV_RESET_LINK", "false").lower() == "true":
            return {"message": "If that email is registered, a reset link has been sent.", "development_token": token}
    except Exception:
        # Do not expose SMTP or account details through this endpoint.
        pass
    return {"message": "If that email is registered, a reset link has been sent."}


@app.post("/auth/reset-password")
def reset_password_endpoint(payload: ResetPasswordRequest) -> dict:
    try:
        reset_password_with_token(payload.token, payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"message": "Password reset successful. Please sign in with your new password."}


@app.get("/auth/me")
def me(current_user: str = Depends(_require_user)) -> dict:
    return {"authenticated": True, "user": {"username": current_user}}


@app.post("/auth/logout")
def logout(authorization: Optional[str] = Header(default=None)) -> dict:
    if authorization and authorization.startswith("Bearer "):
        revoke_session(authorization.removeprefix("Bearer ").strip())
    return {"logged_out": True}


@app.get("/")
def health() -> dict:
    providers = get_available_providers()
    active = [k for k, v in providers.items() if v]
    return {
        "status": "ok",
        "service": "DocuCast",
        "version": "2.0.0",
        "supported_formats": sorted(SUPPORTED_EXTENSIONS),
        "providers": providers,
        "vision": vision_available(),
        "active_providers": active,
        "llm_provider_mode": os.getenv("LLM_PROVIDER", "auto"),
        "note": "If Gemini limits hit, add GROQ_API_KEY (free) or use local fallback - app never breaks",
    }


@app.get("/providers")
def list_providers() -> dict:
    """Show which AI providers are configured and ready.
    
    Helps debug 'limits finished' - see alternatives that work without limits.
    """
    providers = get_available_providers()
    order = os.getenv("LLM_PROVIDER", "auto")
    return {
        "mode": order,
        "providers": providers,
        "setup_guide": {
            "groq": "Free 14k req/day at https://console.groq.com/keys -> set GROQ_API_KEY",
            "openrouter": "Free models at https://openrouter.ai/keys -> set OPENROUTER_API_KEY",
            "huggingface": "Free at https://huggingface.co/settings/tokens -> set HF_TOKEN",
            "ollama": "100% free unlimited offline: install https://ollama.com then `ollama pull llama3.2` + `ollama serve`",
            "local": "Always works, no key needed - TF summarizer + podcast template",
            "cerebras": "Free tier at https://cloud.cerebras.ai/ -> set CEREBRAS_API_KEY",
        },
        "recommendation": "When Gemini limits finished: GROQ_API_KEY is fastest free fix (1 min setup). For unlimited offline, use Ollama or 'local'.",
    }


@app.get("/tts/voices")
def list_tts_voices(current_user: str = Depends(_require_user)) -> dict:
    """Return the selectable Edge-TTS neural voices for the studio controls."""
    return {"voices": [
        {"name": "en-US-JennyNeural", "label": "Jenny · US"},
        {"name": "en-US-GuyNeural", "label": "Guy · US"},
        {"name": "en-US-AriaNeural", "label": "Aria · US"},
        {"name": "en-US-DavisNeural", "label": "Davis · US"},
        {"name": "en-US-ChristopherNeural", "label": "Christopher · US"},
        {"name": "en-US-EricNeural", "label": "Eric · US"},
        {"name": "en-US-MichelleNeural", "label": "Michelle · US"},
        {"name": "en-US-RogerNeural", "label": "Roger · US"},
        {"name": "en-GB-SoniaNeural", "label": "Sonia · UK"},
        {"name": "en-GB-RyanNeural", "label": "Ryan · UK"},
        {"name": "en-AU-NatashaNeural", "label": "Natasha · AU"},
        {"name": "en-AU-WilliamNeural", "label": "William · AU"},
        {"name": "en-IN-NeerjaNeural", "label": "Neerja · India"},
        {"name": "en-IN-PrabhatNeural", "label": "Prabhat · India"},
        {"name": "en-IE-EmilyNeural", "label": "Emily · Ireland"},
        {"name": "en-IE-ConnorNeural", "label": "Connor · Ireland"},
    ]}


@app.get("/jobs/{job_id}")
def jobs_get(job_id: str, current_user: str = Depends(_require_user)) -> dict:
    """Poll a generation job for its real status/stage/result."""
    job = _job_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found (it may have expired).")
    return job


@app.post("/ingest-preview")
def ingest_preview(payload: dict, current_user: str = Depends(_require_user)) -> dict:
    """Preview URL content (article or YouTube) before generating."""
    url = (payload.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="URL is required.")
    try:
        parsed = ingest_url(url)
        return {
            "doc_type": parsed.doc_type,
            "title": parsed.stats.get("title", url),
            "stats": parsed.stats,
            "preview_text": parsed.enriched_text()[:600] + "...",
            "source_text": parsed.enriched_text()[:14000],
            "warnings": parsed.warnings,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/extract-preview")
async def extract_preview(
    files: Optional[List[UploadFile]] = File(None),
    url: Optional[str] = Form(None),
    page_start: int = Form(1),
    page_end: Optional[int] = Form(None),
    selected_pages: Optional[str] = Form(None),
    current_user: str = Depends(_require_user),
) -> dict:
    """Extract a source brief before generation so users can redact it."""
    clean_url = (url or "").strip()
    selected_page_numbers = _parse_selected_pages(selected_pages)
    if clean_url:
        try:
            parsed = ingest_url(clean_url)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Failed to ingest URL: {exc}") from exc
        return {"title": parsed.stats.get("title", clean_url), "doc_type": parsed.doc_type, "source_text": parsed.enriched_text()[:14000], "warnings": parsed.warnings}
    if not files:
        raise HTTPException(status_code=400, detail="Upload a document or provide a URL.")
    if page_start < 1 or (page_end is not None and page_end < page_start):
        raise HTTPException(status_code=400, detail="Page range is invalid.")
    docs = []
    page_stats = []
    for upload in files[:5]:
        data = await upload.read()
        if not data or len(data) > MAX_FILE_BYTES:
            continue
        try:
            parsed = parse_document(data, upload.filename or "document", page_start=page_start, page_end=page_end, selected_pages=selected_page_numbers)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not read '{upload.filename}': {exc}") from exc
        docs.append(f"===== SOURCE: {upload.filename} =====\n{parsed.enriched_text()}")
        page_stats.append(parsed.stats)
    if not docs:
        raise HTTPException(status_code=422, detail="No narratable content was found.")
    return {"title": " + ".join(upload.filename or "document" for upload in files[:5]), "doc_type": "multi" if len(docs) > 1 else "document", "source_text": "\n\n".join(docs)[:14000], "stats": page_stats[0] if len(page_stats) == 1 else {"pages": max((item.get("pages", 0) for item in page_stats), default=0)}, "warnings": []}


@app.post("/generate")
async def generate(
    request: Request,
    files: Optional[List[UploadFile]] = File(None),
    url: Optional[str] = Form(None),
    playlist_id: Optional[str] = Form(None),
    mode: str = Form("dialogue"),
    length: str = Form("standard"),
    tone: str = Form("conversational"),
    audience: str = Form("general"),
    focus: str = Form(""),
    page_start: int = Form(1),
    page_end: Optional[int] = Form(None),
    selected_pages: Optional[str] = Form(None),
    language: str = Form("en"),
    redacted_source: str = Form(""),
    host_a_name: str = Form("NOVA"),
    host_b_name: str = Form("RHYS"),
    host_a_voice: str = Form("en-US-JennyNeural"),
    host_b_voice: str = Form("en-US-GuyNeural"),
    host_a_rate: int = Form(0),
    host_b_rate: int = Form(0),
    host_a_pitch: int = Form(0),
    host_b_pitch: int = Form(0),
    current_user: str = Depends(_require_user),
) -> JSONResponse:
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    clean_url = (url or "").strip()
    selected_page_numbers = _parse_selected_pages(selected_pages)
    if page_start < 1 or (page_end is not None and page_end < page_start):
        raise HTTPException(status_code=400, detail="Page range is invalid.")
    if not files and not clean_url:
        raise HTTPException(status_code=400, detail="Please upload a document or provide an article/YouTube link.")

    options = {
        "mode": mode if mode in {"dialogue", "solo"} else DEFAULT_OPTIONS["mode"],
        "length": length if length in {"brief", "standard", "deep"} else DEFAULT_OPTIONS["length"],
        "tone": tone if tone in {"conversational", "energetic", "calm", "expert"} else DEFAULT_OPTIONS["tone"],
        "audience": audience if audience in {"general", "student", "expert", "executive"} else DEFAULT_OPTIONS["audience"],
        "focus": (focus or "").strip()[:300],
        "language": language if language in SUPPORTED_LANGUAGES else "en",
        "host_a_name": (host_a_name or "NOVA").strip()[:24] or "NOVA",
        "host_b_name": (host_b_name or "RHYS").strip()[:24] or "RHYS",
        "host_a_voice": host_a_voice,
        "host_b_voice": host_b_voice,
        "host_a_rate": max(-50, min(50, host_a_rate)),
        "host_b_rate": max(-50, min(50, host_b_rate)),
        "host_a_pitch": max(-20, min(20, host_a_pitch)),
        "host_b_pitch": max(-20, min(20, host_b_pitch)),
    }

    # Case 1: URL / YouTube ingestion
    if clean_url:
        job_id = _new_job("generate")
        _run_job(job_id, lambda report: _pipeline_generate_url(report, clean_url, options, current_user, playlist_id, redacted_source.strip()[:14000]))
        return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})

    # Case 2: Document upload
    if len(files) > 5:
        raise HTTPException(status_code=400, detail="Upload at most 5 documents per episode.")

    prepared: list[tuple[str, bytes]] = []  # (filename, file_bytes)
    for upload in files:
        filename = (upload.filename or "").strip()
        ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if ext == ".ppt":
            raise HTTPException(
                status_code=400,
                detail=f"'{filename}': legacy .ppt isn't supported — re-save the deck as .pptx and upload again.",
            )
        if ext == ".doc":
            raise HTTPException(
                status_code=400,
                detail=f"'{filename}': legacy .doc isn't supported — re-save the document as .docx and upload again.",
            )
        if ext not in SUPPORTED_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail=f"'{filename}': unsupported type. Upload .pdf, .pptx, .docx, .md or .txt files.",
            )
        if upload.content_type and upload.content_type not in ALLOWED_CONTENT_TYPES and not upload.content_type.startswith("text/"):
            raise HTTPException(
                status_code=400,
                detail=f"'{filename}': unexpected content type '{upload.content_type}'.",
            )

        file_bytes = await upload.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail=f"'{filename}' is empty.")
        if len(file_bytes) > MAX_FILE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"'{filename}' exceeds the 20 MB limit. Please upload a smaller file.",
            )
        prepared.append((filename, file_bytes))

    job_id = _new_job("generate")
    _run_job(job_id, lambda report: _pipeline_generate_files(report, prepared, options, current_user, playlist_id, redacted_source.strip()[:14000], page_start, page_end, selected_page_numbers))
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


def _pipeline_generate_url(report, url: str, options: dict, username: str, playlist_id: Optional[str] = None, redacted_source: str = "") -> dict:
    """Ingest a web article or YouTube URL and run script + TTS."""
    report("ingesting url", 10)
    try:
        parsed = ingest_url(url)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Failed to ingest URL: {exc}") from exc

    title = parsed.stats.get("title") or url
    return _synthesize_and_save(report, parsed, title, options, username, playlist_id, start_pct=25, redacted_source=redacted_source)


def _pipeline_generate_files(report, prepared: list, options: dict, username: str, playlist_id: Optional[str] = None, redacted_source: str = "", page_start: int = 1, page_end: Optional[int] = None, selected_pages: Optional[list[int]] = None) -> dict:
    """The multi-file parse → script → TTS pipeline with real progress reporting."""
    parsed_docs = []
    for i, (filename, file_bytes) in enumerate(prepared):
        share = 5 + int(15 * (i + 1) / len(prepared))
        report(f"parsing ({i + 1}/{len(prepared)})", share)
        try:
            parsed = parse_document(file_bytes, filename, page_start=page_start, page_end=page_end, selected_pages=selected_pages)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"'{filename}': {exc}") from exc
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read '{filename}': {exc}") from exc
        if not parsed.enriched_text().strip():
            raise HTTPException(
                status_code=422,
                detail=f"No narratable content was found in '{filename}'.",
            )
        parsed_docs.append((filename, parsed))

    if len(parsed_docs) == 1:
        merged = parsed_docs[0][1]
        display_name = parsed_docs[0][0]
    else:
        sections = []
        combined = ParsedDocument(doc_type="multi")
        for filename, parsed in parsed_docs:
            sections.append(f"===== SOURCE: {filename} =====\n{parsed.enriched_text()}")
            combined.tables.extend(parsed.tables)
            combined.images.extend(parsed.images[:MAX_IMAGES])
            combined.figures.extend(parsed.figures)
            combined.charts.extend(parsed.charts)
            combined.handwritten_notes.extend(parsed.handwritten_notes)
            combined.speaker_notes.extend(parsed.speaker_notes)
            combined.warnings.extend(parsed.warnings)
        combined.text = "\n\n".join(sections)
        merged = combined
        display_name = " + ".join(name for name, _ in parsed_docs)

    return _synthesize_and_save(report, merged, display_name, options, username, playlist_id, start_pct=25, redacted_source=redacted_source)


def _synthesize_and_save(
    report,
    doc: ParsedDocument,
    display_name: str,
    options: dict,
    username: str,
    playlist_id: Optional[str] = None,
    start_pct: int = 25,
    redacted_source: str = "",
) -> dict:
    """Common generation, voicing with timestamps, and MongoDB persistence."""
    enriched = redacted_source.strip() or doc.enriched_text()

    # --- Script ---
    report("script", start_pct + 15)
    try:
        script, provider_used = generate_script_with_provider(enriched, None, options)
    except ValueError as exc:
        msg = str(exc)
        if "quota" in msg.lower() or "limit" in msg.lower() or "429" in msg:
            msg += " Tip: Set GROQ_API_KEY (free at console.groq.com) or LLM_PROVIDER=local for unlimited offline."
        raise HTTPException(status_code=502, detail=msg) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Script generation failed: {exc}") from exc

    # --- Show notes ---
    report("show notes", start_pct + 30)
    show_notes = None
    try:
        show_notes = generate_show_notes(script, options)
    except Exception:
        show_notes = None

    # --- Audio with per-turn timestamps (Feature 5) ---
    report("synthesizing", start_pct + 50)
    audio_base64: Optional[str] = None
    audio_error: Optional[str] = None
    audio_engine: Optional[str] = None
    audio_mime: Optional[str] = None
    transcript_segments: list = []

    try:
        audio_bytes, audio_engine, audio_mime, transcript_segments = generate_audio(script, options)
        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    except ValueError as exc:
        audio_error = str(exc)
    except Exception as exc:
        audio_error = f"Audio synthesis failed: {exc}"

    analysis = doc.summary_payload()
    payload: dict = {
        "script": script,
        "audio_base64": audio_base64,
        "audio_engine": audio_engine,
        "audio_mime": audio_mime,
        "transcript_segments": transcript_segments,
        "provider": provider_used,
        "options": options,
        "analysis": analysis,
        "filename": display_name,
        "show_notes": show_notes,
        "playlist_id": playlist_id,
    }
    if audio_engine == "espeak-ng":
        payload["audio_note"] = (
            "Audio was synthesized with the offline fallback voice. "
            "On a normal network you'll get neural voices automatically."
        )
    if audio_error:
        payload["audio_error"] = audio_error

    # --- Persist to MongoDB ---
    report("saving", 95)
    episode_id: Optional[str] = None
    try:
        episode_id = save_episode(username, {
            "filename": display_name,
            "doc_type": doc.doc_type,
            "mode": options["mode"],
            "length": options["length"],
            "tone": options["tone"],
            "audience": options["audience"],
            "focus": options["focus"],
            "provider": provider_used,
            "audio_engine": audio_engine,
            "audio_mime": audio_mime,
            "script": script,
            "audio_base64": audio_base64,
            "transcript_segments": transcript_segments,
            "analysis": analysis,
            "source_text": enriched,
            "show_notes": show_notes,
            "playlist_id": playlist_id,
        })
        payload["episode_id"] = episode_id
        if playlist_id:
            add_episode_to_playlist(username, playlist_id, episode_id)
    except Exception as exc:
        payload["history_error"] = f"Episode could not be saved to library: {exc}"

    return payload


@app.post("/regenerate")
def regenerate(
    request: Request,
    episode_id: str = Form(...),
    mode: str = Form("dialogue"),
    length: str = Form("standard"),
    tone: str = Form("conversational"),
    audience: str = Form("general"),
    focus: str = Form(""),
    language: str = Form("en"),
    host_a_name: str = Form("NOVA"),
    host_b_name: str = Form("RHYS"),
    host_a_voice: str = Form("en-US-JennyNeural"),
    host_b_voice: str = Form("en-US-GuyNeural"),
    host_a_rate: int = Form(0),
    host_b_rate: int = Form(0),
    host_a_pitch: int = Form(0),
    host_b_pitch: int = Form(0),
    current_user: str = Depends(_require_user),
) -> JSONResponse:
    """Re-run script generation + TTS for a saved episode WITHOUT re-uploading."""
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    source = get_episode_source(current_user, episode_id)
    if source is None or not source.strip():
        existing = get_episode(current_user, episode_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Episode not found.")
        raise HTTPException(
            status_code=410,
            detail="This episode has no stored source text — re-upload the document.",
        )

    options = {
        "mode": mode if mode in {"dialogue", "solo"} else DEFAULT_OPTIONS["mode"],
        "length": length if length in {"brief", "standard", "deep"} else DEFAULT_OPTIONS["length"],
        "tone": tone if tone in {"conversational", "energetic", "calm", "expert"} else DEFAULT_OPTIONS["tone"],
        "audience": audience if audience in {"general", "student", "expert", "executive"} else DEFAULT_OPTIONS["audience"],
        "focus": (focus or "").strip()[:300],
        "language": language if language in SUPPORTED_LANGUAGES else "en",
        "host_a_name": (host_a_name or "NOVA").strip()[:24] or "NOVA",
        "host_b_name": (host_b_name or "RHYS").strip()[:24] or "RHYS",
        "host_a_voice": host_a_voice,
        "host_b_voice": host_b_voice,
        "host_a_rate": max(-50, min(50, host_a_rate)),
        "host_b_rate": max(-50, min(50, host_b_rate)),
        "host_a_pitch": max(-20, min(20, host_a_pitch)),
        "host_b_pitch": max(-20, min(20, host_b_pitch)),
    }

    job_id = _new_job("regenerate")
    _run_job(job_id, lambda report: _pipeline_regenerate(report, episode_id, source, options, current_user))
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


def _pipeline_regenerate(report, episode_id: str, source: str, options: dict, username: str) -> dict:
    report("script", 40)
    try:
        script, provider_used = generate_script_with_provider(source, None, options)
    except ValueError as exc:
        msg = str(exc)
        if "quota" in msg.lower() or "limit" in msg.lower() or "429" in msg:
            msg += " Tip: Set GROQ_API_KEY (free at console.groq.com) or LLM_PROVIDER=local for unlimited offline."
        raise HTTPException(status_code=502, detail=msg) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Script generation failed: {exc}") from exc

    report("synthesizing", 75)
    audio_error: Optional[str] = None
    audio_base64: Optional[str] = None
    audio_engine: Optional[str] = None
    audio_mime: Optional[str] = None
    transcript_segments: list = []
    try:
        audio_bytes, audio_engine, audio_mime, transcript_segments = generate_audio(script, options)
        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    except ValueError as exc:
        audio_error = str(exc)
    except Exception as exc:
        audio_error = f"Audio synthesis failed: {exc}"

    report("saving", 95)
    try:
        update_episode_script(username, episode_id, script, audio_base64, audio_engine, audio_mime, transcript_segments)
    except Exception as exc:
        audio_error = audio_error or f"Episode update failed: {exc}"

    payload = {
        "script": script,
        "audio_base64": audio_base64,
        "audio_engine": audio_engine,
        "audio_mime": audio_mime,
        "transcript_segments": transcript_segments,
        "provider": provider_used,
        "options": options,
        "episode_id": episode_id,
        "regenerated": True,
    }
    if audio_error:
        payload["audio_error"] = audio_error
    return payload


@app.post("/resynthesize")
def resynthesize(
    request: Request,
    payload_in: ResynthesizeRequest,
    current_user: str = Depends(_require_user),
) -> JSONResponse:
    """Take an edited script and produce fresh audio (no LLM call, no re-parse)."""
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    script = (payload_in.script or "").strip()
    if not script:
        raise HTTPException(status_code=400, detail="Script is empty — nothing to synthesize.")
    if len(script) > 60_000:
        raise HTTPException(status_code=413, detail="Script is too long (max ~60,000 characters).")

    job_id = _new_job("resynthesize")
    _run_job(job_id, lambda report: _pipeline_resynthesize(report, script))
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


def _pipeline_resynthesize(report, script: str) -> dict:
    report("synthesizing", 60)
    try:
        audio_bytes, audio_engine, audio_mime, transcript_segments = generate_audio(script)
        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Audio synthesis failed: {exc}") from exc
    return {
        "script": script,
        "audio_base64": audio_base64,
        "audio_engine": audio_engine,
        "audio_mime": audio_mime,
        "transcript_segments": transcript_segments,
    }


# ---------------------------------------------------------------------------
# Batch Mode / Playlists (Feature 6)
# ---------------------------------------------------------------------------
@app.post("/batch-generate")
async def batch_generate(
    request: Request,
    files: Optional[List[UploadFile]] = File(None),
    urls: Optional[str] = Form(None),
    playlist_title: str = Form("Untitled Series"),
    description: str = Form(""),
    mode: str = Form("dialogue"),
    length: str = Form("standard"),
    tone: str = Form("conversational"),
    audience: str = Form("general"),
    focus: str = Form(""),
    language: str = Form("en"),
    host_a_name: str = Form("NOVA"),
    host_b_name: str = Form("RHYS"),
    host_a_voice: str = Form("en-US-JennyNeural"),
    host_b_voice: str = Form("en-US-GuyNeural"),
    host_a_rate: int = Form(0),
    host_b_rate: int = Form(0),
    host_a_pitch: int = Form(0),
    host_b_pitch: int = Form(0),
    current_user: str = Depends(_require_user),
) -> JSONResponse:
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    parsed_items = []
    if files:
        for upload in files:
            filename = (upload.filename or "").strip()
            ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
            if ext not in SUPPORTED_EXTENSIONS:
                continue
            file_bytes = await upload.read()
            if file_bytes and len(file_bytes) <= MAX_FILE_BYTES:
                parsed_items.append(("file", filename, file_bytes))

    if urls:
        raw_urls = []
        try:
            val = json.loads(urls)
            if isinstance(val, list):
                raw_urls = [str(u).strip() for u in val if str(u).strip()]
        except Exception:
            raw_urls = [u.strip() for u in re.split(r"[\n,]+", urls) if u.strip()]
        for u in raw_urls:
            parsed_items.append(("url", u, u))

    if not parsed_items:
        raise HTTPException(status_code=400, detail="Provide at least one document or URL for the batch queue.")
    if len(parsed_items) > 15:
        raise HTTPException(status_code=400, detail="Batch queue is limited to 15 items at a time.")

    options = {
        "mode": mode if mode in {"dialogue", "solo"} else DEFAULT_OPTIONS["mode"],
        "length": length if length in {"brief", "standard", "deep"} else DEFAULT_OPTIONS["length"],
        "tone": tone if tone in {"conversational", "energetic", "calm", "expert"} else DEFAULT_OPTIONS["tone"],
        "audience": audience if audience in {"general", "student", "expert", "executive"} else DEFAULT_OPTIONS["audience"],
        "focus": (focus or "").strip()[:300],
        "language": language if language in SUPPORTED_LANGUAGES else "en",
        "host_a_name": (host_a_name or "NOVA").strip()[:24] or "NOVA",
        "host_b_name": (host_b_name or "RHYS").strip()[:24] or "RHYS",
        "host_a_voice": host_a_voice,
        "host_b_voice": host_b_voice,
        "host_a_rate": max(-50, min(50, host_a_rate)),
        "host_b_rate": max(-50, min(50, host_b_rate)),
        "host_a_pitch": max(-20, min(20, host_a_pitch)),
        "host_b_pitch": max(-20, min(20, host_b_pitch)),
    }

    job_id = _new_job("batch-generate")
    _run_job(job_id, lambda report: _pipeline_batch_generate(
        report, parsed_items, playlist_title, description, options, current_user
    ))
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


def _pipeline_batch_generate(
    report,
    items: list,
    playlist_title: str,
    description: str,
    options: dict,
    username: str,
) -> dict:
    total_items = len(items)
    playlist_id = save_playlist(username, playlist_title, description, episode_ids=[])
    generated_episodes = []

    for idx, (kind, name, data) in enumerate(items):
        item_num = idx + 1
        pct_start = int(idx * 100 / total_items)
        pct_range = int(100 / total_items)

        def item_report(stage: str, sub_pct: int):
            scaled = pct_start + int(sub_pct * pct_range / 100)
            report(f"item {item_num}/{total_items}: {stage}", scaled)

        item_report("parsing", 10)
        try:
            if kind == "file":
                doc = parse_document(data, name)
                display_name = name
            else:
                doc = ingest_url(data)
                display_name = doc.stats.get("title") or name

            ep_res = _synthesize_and_save(
                item_report, doc, display_name, options, username, playlist_id=playlist_id, start_pct=25
            )
            generated_episodes.append(ep_res)
        except Exception as exc:
            print(f"[batch] item {name} failed: {exc}")

    report("done", 100)
    playlist = get_playlist(username, playlist_id)
    return {
        "playlist_id": playlist_id,
        "playlist": playlist,
        "episodes_count": len(generated_episodes),
    }


@app.get("/playlists")
def playlists_list(current_user: str = Depends(_require_user)) -> dict:
    return {"playlists": list_playlists(current_user)}


@app.get("/playlists/{playlist_id}")
def playlists_get(playlist_id: str, current_user: str = Depends(_require_user)) -> dict:
    pl = get_playlist(current_user, playlist_id)
    if pl is None:
        raise HTTPException(status_code=404, detail="Playlist not found.")
    return pl


@app.delete("/playlists/{playlist_id}")
def playlists_delete(playlist_id: str, current_user: str = Depends(_require_user)) -> dict:
    if not delete_playlist(current_user, playlist_id):
        raise HTTPException(status_code=404, detail="Playlist not found.")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Episodes & Chat
# ---------------------------------------------------------------------------
@app.get("/episodes")
def episodes_list(
    current_user: str = Depends(_require_user),
    limit: int = 50,
) -> dict:
    limit = max(1, min(limit, 100))
    return list_episodes(current_user, limit=limit)


@app.get("/episodes/{episode_id}")
def episodes_get(episode_id: str, current_user: str = Depends(_require_user)) -> dict:
    episode = get_episode(current_user, episode_id)
    if episode is None:
        raise HTTPException(status_code=404, detail="Episode not found.")
    return episode


@app.delete("/episodes/{episode_id}")
def episodes_delete(episode_id: str, current_user: str = Depends(_require_user)) -> dict:
    if not delete_episode(current_user, episode_id):
        raise HTTPException(status_code=404, detail="Episode not found.")
    return {"deleted": True}


class ChatRequest(BaseModel):
    question: str


@app.get("/episodes/{episode_id}/chat")
def chat_history(episode_id: str, current_user: str = Depends(_require_user)) -> dict:
    """Load the saved Q&A thread for one episode."""
    return {"messages": list_chat_messages(current_user, episode_id)}


@app.post("/episodes/{episode_id}/chat")
def chat_ask(
    episode_id: str,
    payload_in: ChatRequest,
    current_user: str = Depends(_require_user),
) -> dict:
    """Ask a question about the episode's document; answer grounded in its brief."""
    question = (payload_in.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Ask a question first.")
    if len(question) > 1000:
        raise HTTPException(status_code=400, detail="Question is too long (max 1,000 characters).")

    source = get_episode_source(current_user, episode_id)
    if source is None:
        existing = get_episode(current_user, episode_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Episode not found.")
        raise HTTPException(
            status_code=410,
            detail="This episode has no stored source text — chat needs a fresh generation.",
        )

    try:
        history = list_chat_messages(current_user, episode_id)
        answer = answer_question(source, question, history)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Chat failed: {exc}") from exc

    audio_payload = {}
    try:
        audio_bytes, audio_engine, audio_mime, transcript_segments = generate_audio(f"NOVA: {answer}")
        audio_payload = {
            "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
            "audio_mime": audio_mime,
            "audio_engine": audio_engine,
            "transcript_segments": transcript_segments,
        }
    except Exception:
        # Voice replies are an enhancement; never make grounded text chat fail.
        pass

    try:
        add_chat_message(current_user, episode_id, "user", question)
        add_chat_message(current_user, episode_id, "assistant", answer)
    except Exception:
        pass

    return {"answer": answer, **audio_payload}


@app.delete("/episodes/{episode_id}/chat")
def chat_clear(episode_id: str, current_user: str = Depends(_require_user)) -> dict:
    cleared = clear_chat_messages(current_user, episode_id)
    return {"cleared": cleared}
