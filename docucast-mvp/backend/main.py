"""FastAPI entrypoint for DocuCast MVP - with free unlimited AI alternatives."""

import base64
import json
import os
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from utils.auth import (
    authenticate_user,
    create_session,
    delete_episode,
    ensure_user,
    get_episode,
    initialize_database,
    list_episodes,
    register_user,
    revoke_session,
    save_episode,
    verify_session,
)
from utils.document_parser import SUPPORTED_EXTENSIONS, parse_document
from utils.script_generator import (
    DEFAULT_OPTIONS,
    generate_script_with_provider,
    get_available_providers,
)
from utils.tts_engine import generate_audio
from utils.vision import vision_available

load_dotenv()

MAX_FILE_BYTES = 20 * 1024 * 1024  # 20 MB (PPTX decks with images run large)
ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    initialize_database()
    ensure_user(AUTH_USERNAME, AUTH_PASSWORD)
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


@app.post("/generate")
async def generate(
    request: Request,
    file: UploadFile = File(...),
    mode: str = Form("dialogue"),
    length: str = Form("standard"),
    tone: str = Form("conversational"),
    audience: str = Form("general"),
    focus: str = Form(""),
    current_user: str = Depends(_require_user),
) -> JSONResponse:
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    # --- Validate file --------------------------------------------------------
    filename = (file.filename or "").strip()
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext == ".ppt":
        raise HTTPException(
            status_code=400,
            detail="Legacy .ppt isn't supported — re-save the deck as .pptx and upload again.",
        )
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Upload a .pdf, .pptx, .md or .txt file.",
        )
    if file.content_type and file.content_type not in ALLOWED_CONTENT_TYPES and not file.content_type.startswith("text/"):
        raise HTTPException(
            status_code=400,
            detail=f"Unexpected content type '{file.content_type}'. Upload a .pdf, .pptx, .md or .txt file.",
        )

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(file_bytes) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File exceeds the 20 MB limit. Please upload a smaller file.",
        )

    # --- Validate options ------------------------------------------------------
    options = {
        "mode": mode if mode in {"dialogue", "solo"} else DEFAULT_OPTIONS["mode"],
        "length": length if length in {"brief", "standard", "deep"} else DEFAULT_OPTIONS["length"],
        "tone": tone if tone in {"conversational", "energetic", "calm", "expert"} else DEFAULT_OPTIONS["tone"],
        "audience": audience if audience in {"general", "student", "expert", "executive"} else DEFAULT_OPTIONS["audience"],
        "focus": (focus or "").strip()[:300],
    }

    # --- Parse document: text + tables + images + charts + handwriting ---------
    # Parsing, LLM calls and TTS are all synchronous and slow — run them in the
    # threadpool so one long generate request never blocks the event loop.
    try:
        parsed = await run_in_threadpool(parse_document, file_bytes, filename)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read this file: {exc}") from exc

    enriched = parsed.enriched_text()
    if not enriched.strip():
        raise HTTPException(
            status_code=422,
            detail="No narratable content was found in this document.",
        )

    # --- Generate script (Multi-provider with automatic fallback) -----------
    try:
        script, provider_used = await run_in_threadpool(
            generate_script_with_provider, enriched, None, options
        )
    except ValueError as exc:
        msg = str(exc)
        if "quota" in msg.lower() or "limit" in msg.lower() or "429" in msg:
            msg += " Tip: Set GROQ_API_KEY (free at console.groq.com) or LLM_PROVIDER=local for unlimited offline."
        raise HTTPException(status_code=502, detail=msg) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Script generation failed: {exc}. Try setting GROQ_API_KEY or LLM_PROVIDER=local"
        ) from exc

    # --- Synthesize audio (Edge-TTS → gTTS → Piper → espeak-ng offline) -------
    audio_base64: Optional[str] = None
    audio_error: Optional[str] = None
    audio_engine: Optional[str] = None
    audio_mime: Optional[str] = None
    try:
        audio_result = await run_in_threadpool(generate_audio, script)
        audio_bytes, audio_engine, audio_mime = audio_result
        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    except ValueError as exc:
        audio_error = str(exc)
    except Exception as exc:
        audio_error = f"Audio synthesis failed: {exc}"

    payload: dict = {
        "script": script,
        "audio_base64": audio_base64,
        "audio_engine": audio_engine,
        "audio_mime": audio_mime,
        "provider": provider_used,
        "options": options,
        "analysis": parsed.summary_payload(),
        "filename": filename,
    }
    if audio_engine == "espeak-ng":
        payload["audio_note"] = (
            "Audio was synthesized with the offline fallback voice (cloud TTS unreachable). "
            "It always works, but sounds robotic — on a normal network you'll get neural voices automatically."
        )
    if audio_error:
        payload["audio_error"] = audio_error
    # Add helpful note if fallback was used
    if provider_used == "local":
        payload["provider_note"] = "Generated with local fallback (no API) - unlimited. For higher quality, set GROQ_API_KEY (free)."
    elif provider_used != "gemini":
        payload["provider_note"] = f"Generated with {provider_used} (Gemini alternative) - free tier."

    # --- Persist to the user's history (best-effort; never fails the request) --
    episode_id: Optional[int] = None
    try:
        episode_id = save_episode(current_user, {
            "filename": filename,
            "doc_type": parsed.doc_type,
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
            "analysis_json": json.dumps(parsed.summary_payload()),
        })
        payload["episode_id"] = episode_id
    except Exception as exc:  # history is a nicety, not a requirement
        payload["history_error"] = f"Episode could not be saved to history: {exc}"

    return JSONResponse(status_code=200, content=payload)


@app.get("/episodes")
def episodes_list(
    current_user: str = Depends(_require_user),
    limit: int = 50,
) -> dict:
    limit = max(1, min(limit, 100))
    return {"episodes": list_episodes(current_user, limit=limit)}


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
