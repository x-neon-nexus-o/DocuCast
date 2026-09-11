"""FastAPI entrypoint for DocuCast MVP - with free unlimited AI alternatives."""

import base64
import json
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import List, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from utils.auth import (
    add_chat_message,
    authenticate_user,
    clear_chat_messages,
    create_session,
    delete_episode,
    ensure_user,
    get_episode,
    get_episode_source,
    initialize_database,
    list_chat_messages,
    list_episodes,
    register_user,
    reset_password,
    revoke_session,
    save_episode,
    update_episode_script,
    verify_session,
)
from utils.document_parser import MAX_IMAGES, SUPPORTED_EXTENSIONS, ParsedDocument, parse_document
from utils.script_generator import (
    DEFAULT_OPTIONS,
    answer_question,
    generate_script_with_provider,
    generate_show_notes,
    get_available_providers,
)
from utils.tts_engine import generate_audio
from utils.vision import vision_available

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


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str


class ResynthesizeRequest(BaseModel):
    script: str


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
        register_user(payload.username, payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    access_token = create_session(payload.username.strip(), AUTH_TOKEN_TTL_SECONDS)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {"username": payload.username.strip()},
    }


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


@app.get("/jobs/{job_id}")
def jobs_get(job_id: str, current_user: str = Depends(_require_user)) -> dict:
    """Poll a generation job for its real status/stage/result."""
    job = _job_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found (it may have expired).")
    return job


@app.post("/generate")
async def generate(
    request: Request,
    files: List[UploadFile] = File(...),
    mode: str = Form("dialogue"),
    length: str = Form("standard"),
    tone: str = Form("conversational"),
    audience: str = Form("general"),
    focus: str = Form(""),
    current_user: str = Depends(_require_user),
) -> JSONResponse:
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    # --- Validate files (fast, synchronous — bad uploads fail immediately) ----
    if not files:
        raise HTTPException(status_code=400, detail="No file uploaded.")
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

    # --- Validate options ------------------------------------------------------
    options = {
        "mode": mode if mode in {"dialogue", "solo"} else DEFAULT_OPTIONS["mode"],
        "length": length if length in {"brief", "standard", "deep"} else DEFAULT_OPTIONS["length"],
        "tone": tone if tone in {"conversational", "energetic", "calm", "expert"} else DEFAULT_OPTIONS["tone"],
        "audience": audience if audience in {"general", "student", "expert", "executive"} else DEFAULT_OPTIONS["audience"],
        "focus": (focus or "").strip()[:300],
    }

    # --- Kick off the pipeline in the background; the client polls /jobs/{id} --
    job_id = _new_job("generate")
    _run_job(job_id, lambda report: _pipeline_generate(report, prepared, options, current_user))
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


def _pipeline_generate(report, prepared: list, options: dict, username: str) -> dict:
    """The full parse → script → TTS pipeline with real progress reporting.

    `prepared` is [(filename, bytes), ...] — one source or several. Multiple
    documents are parsed separately and their briefs merged with per-source
    labels so the hosts can compare and connect the material.
    """
    # --- Parse every source ----------------------------------------------------
    parsed_docs = []
    for i, (filename, file_bytes) in enumerate(prepared):
        share = 5 + int(10 * (i + 1) / len(prepared))  # parsing spans ~5-15%
        report(f"parsing ({i + 1}/{len(prepared)})", share)
        try:
            parsed = parse_document(file_bytes, filename)
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

    # --- Merge briefs (multi-doc episodes get labeled sections) ----------------
    if len(parsed_docs) == 1:
        enriched = parsed_docs[0][1].enriched_text()
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
        enriched = "\n\n".join(sections)
        merged = combined
        display_name = " + ".join(name for name, _ in parsed_docs)

    # --- Script ------------------------------------------------------------------
    report("script", 45)
    try:
        script, provider_used = generate_script_with_provider(enriched, None, options)
    except ValueError as exc:
        msg = str(exc)
        if "quota" in msg.lower() or "limit" in msg.lower() or "429" in msg:
            msg += " Tip: Set GROQ_API_KEY (free at console.groq.com) or LLM_PROVIDER=local for unlimited offline."
        raise HTTPException(status_code=502, detail=msg) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Script generation failed: {exc}. Try setting GROQ_API_KEY or LLM_PROVIDER=local"
        ) from exc

    # --- Show notes + chapters (best-effort; skipped if no provider can) ---------
    report("show notes", 55)
    show_notes = None
    try:
        show_notes = generate_show_notes(script, options)
    except Exception:
        show_notes = None

    # --- Audio --------------------------------------------------------------------
    report("synthesizing", 75)
    audio_base64: Optional[str] = None
    audio_error: Optional[str] = None
    audio_engine: Optional[str] = None
    audio_mime: Optional[str] = None
    try:
        audio_bytes, audio_engine, audio_mime = generate_audio(script)
        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    except ValueError as exc:
        audio_error = str(exc)
    except Exception as exc:
        audio_error = f"Audio synthesis failed: {exc}"

    # --- Analysis payload (multi-doc merges stats/warnings) ------------------------
    analysis = merged.summary_payload()
    analysis["sources"] = [name for name, _ in parsed_docs]
    if len(parsed_docs) > 1:
        analysis["warnings"].insert(
            0, f"Episode synthesized from {len(parsed_docs)} documents: {display_name}."
        )

    payload: dict = {
        "script": script,
        "audio_base64": audio_base64,
        "audio_engine": audio_engine,
        "audio_mime": audio_mime,
        "provider": provider_used,
        "options": options,
        "analysis": analysis,
        "filename": display_name,
        "show_notes": show_notes,
    }
    if audio_engine == "espeak-ng":
        payload["audio_note"] = (
            "Audio was synthesized with the offline fallback voice (cloud TTS unreachable). "
            "It always works, but sounds robotic — on a normal network you'll get neural voices automatically."
        )
    if audio_error:
        payload["audio_error"] = audio_error
    if provider_used == "local":
        payload["provider_note"] = "Generated with local fallback (no API) - unlimited. For higher quality, set GROQ_API_KEY (free)."
    elif provider_used != "gemini":
        payload["provider_note"] = f"Generated with {provider_used} (Gemini alternative) - free tier."

    # --- Persist to the user's history (best-effort; never fails the request) -----
    report("saving", 95)
    episode_id: Optional[int] = None
    try:
        episode_id = save_episode(username, {
            "filename": display_name,
            "doc_type": merged.doc_type,
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
            "analysis_json": json.dumps(analysis),
            "source_text": enriched,
            "show_notes_json": json.dumps(show_notes) if show_notes else None,
        })
        payload["episode_id"] = episode_id
    except Exception as exc:  # history is a nicety, not a requirement
        payload["history_error"] = f"Episode could not be saved to history: {exc}"

    return payload


@app.post("/regenerate")
def regenerate(
    request: Request,
    episode_id: int = Form(...),
    mode: str = Form("dialogue"),
    length: str = Form("standard"),
    tone: str = Form("conversational"),
    audience: str = Form("general"),
    focus: str = Form(""),
    current_user: str = Depends(_require_user),
) -> JSONResponse:
    """Re-run script generation + TTS for a saved episode WITHOUT re-uploading.

    Reuses the stored enriched source text (no re-parse) with the new options.
    """
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    source = get_episode_source(current_user, episode_id)
    if source is None or not source.strip():
        existing = get_episode(current_user, episode_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Episode not found.")
        raise HTTPException(
            status_code=410,
            detail="This episode has no stored source text (generated before v2.1) — re-upload the document.",
        )

    options = {
        "mode": mode if mode in {"dialogue", "solo"} else DEFAULT_OPTIONS["mode"],
        "length": length if length in {"brief", "standard", "deep"} else DEFAULT_OPTIONS["length"],
        "tone": tone if tone in {"conversational", "energetic", "calm", "expert"} else DEFAULT_OPTIONS["tone"],
        "audience": audience if audience in {"general", "student", "expert", "executive"} else DEFAULT_OPTIONS["audience"],
        "focus": (focus or "").strip()[:300],
    }

    job_id = _new_job("regenerate")
    _run_job(job_id, lambda report: _pipeline_regenerate(report, episode_id, source, options, current_user))
    return JSONResponse(status_code=202, content={"job_id": job_id, "status": "queued"})


def _pipeline_regenerate(report, episode_id: int, source: str, options: dict, username: str) -> dict:
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
    try:
        audio_bytes, audio_engine, audio_mime = generate_audio(script)
        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    except ValueError as exc:
        audio_error = str(exc)
    except Exception as exc:
        audio_error = f"Audio synthesis failed: {exc}"

    report("saving", 95)
    try:
        update_episode_script(username, episode_id, script, audio_base64, audio_engine, audio_mime)
    except Exception as exc:
        audio_error = audio_error or f"Episode update failed: {exc}"

    payload = {
        "script": script,
        "audio_base64": audio_base64,
        "audio_engine": audio_engine,
        "audio_mime": audio_mime,
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
    """Take an edited script and produce fresh audio (no LLM call, no re-parse).

    This is the "edit the script, keep the show" path: users fix names, tweak
    wording, then re-synthesize audio directly from the edited text.
    """
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
        audio_bytes, audio_engine, audio_mime = generate_audio(script)
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
    }


@app.get("/episodes")
def episodes_list(
    current_user: str = Depends(_require_user),
    limit: int = 50,
) -> dict:
    limit = max(1, min(limit, 100))
    return list_episodes(current_user, limit=limit)


@app.get("/episodes/{episode_id}")
def episodes_get(episode_id: int, current_user: str = Depends(_require_user)) -> dict:
    episode = get_episode(current_user, episode_id)
    if episode is None:
        raise HTTPException(status_code=404, detail="Episode not found.")
    return episode


@app.delete("/episodes/{episode_id}")
def episodes_delete(episode_id: int, current_user: str = Depends(_require_user)) -> dict:
    if not delete_episode(current_user, episode_id):
        raise HTTPException(status_code=404, detail="Episode not found.")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Chat with the document (grounded in the episode's stored source text)
# ---------------------------------------------------------------------------
class ChatRequest(BaseModel):
    question: str


@app.get("/episodes/{episode_id}/chat")
def chat_history(episode_id: int, current_user: str = Depends(_require_user)) -> dict:
    """Load the saved Q&A thread for one episode."""
    # Ownership is enforced inside list_chat_messages via the join.
    return {"messages": list_chat_messages(current_user, episode_id)}


@app.post("/episodes/{episode_id}/chat")
def chat_ask(
    episode_id: int,
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
            detail="This episode has no stored source text (generated before v2.1) — chat needs a fresh generation.",
        )

    try:
        history = list_chat_messages(current_user, episode_id)
        answer = answer_question(source, question, history)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Chat failed: {exc}") from exc

    # Persist the turn (best-effort).
    try:
        add_chat_message(current_user, episode_id, "user", question)
        add_chat_message(current_user, episode_id, "assistant", answer)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception:
        pass  # chat history is a nicety

    return {"answer": answer}


@app.delete("/episodes/{episode_id}/chat")
def chat_clear(episode_id: int, current_user: str = Depends(_require_user)) -> dict:
    cleared = clear_chat_messages(current_user, episode_id)
    return {"cleared": cleared}
