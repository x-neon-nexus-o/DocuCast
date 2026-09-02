"""FastAPI entrypoint for DocuCast MVP - with free unlimited AI alternatives."""

import base64
import os
import time
from collections import defaultdict, deque
from typing import Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from utils.auth import (
    authenticate_user,
    create_session,
    ensure_user,
    initialize_database,
    register_user,
    revoke_session,
    verify_session,
)
from utils.pdf_parser import extract_text_from_pdf
from utils.script_generator import generate_script_with_provider, get_available_providers
from utils.tts_engine import generate_audio_bytes

load_dotenv()

MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB
ALLOWED_CONTENT_TYPES = {"application/pdf"}

# Simple per-IP in-memory throttle: max N requests within WINDOW seconds.
THROTTLE_MAX_REQUESTS = 5
THROTTLE_WINDOW_SECONDS = 60
_request_log: dict[str, deque] = defaultdict(deque)

# Allowed CORS origins: Vercel deployment (set via env) + localhost for dev.
_prod_origin = os.getenv("VERCEL_ORIGIN", "").strip().rstrip("/")
allow_origins = [
    origin
    for origin in [
        _prod_origin,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ]
    if origin
]
# If no prod origin set, allow all for dev/preview (Arena, Codespaces etc)
if not allow_origins:
    allow_origins = ["*"]

app = FastAPI(title="DocuCast MVP", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins if allow_origins != ["*"] else ["*"],
    allow_credentials=True if allow_origins != ["*"] else False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

AUTH_USERNAME = os.getenv("DOCUCAST_USERNAME", "admin")
AUTH_PASSWORD = os.getenv("DOCUCAST_PASSWORD", "docucast")
AUTH_TOKEN_TTL_SECONDS = int(os.getenv("DOCUCAST_TOKEN_TTL_SECONDS", "43200"))


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str


@app.on_event("startup")
def _startup() -> None:
    initialize_database()
    ensure_user(AUTH_USERNAME, AUTH_PASSWORD)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_throttle(ip: str) -> None:
    now = time.time()
    log = _request_log[ip]
    while log and now - log[0] > THROTTLE_WINDOW_SECONDS:
        log.popleft()
    if len(log) >= THROTTLE_MAX_REQUESTS:
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
def login(payload: LoginRequest) -> dict:
    if not authenticate_user(payload.username, payload.password):
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    access_token = create_session(payload.username, AUTH_TOKEN_TTL_SECONDS)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": {"username": payload.username},
    }


@app.post("/auth/register")
def register(payload: RegisterRequest) -> dict:
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
        "service": "DocuCast MVP",
        "version": "1.1.0",
        "providers": providers,
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
    current_user: str = Depends(_require_user),
) -> JSONResponse:
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are accepted. Please upload a .pdf file.",
        )

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(file_bytes) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File exceeds the 10 MB limit. Please upload a smaller PDF.",
        )

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are accepted. Please upload a .pdf file.",
        )

    # --- Extract text ------------------------------------------------------
    try:
        extracted_text = extract_text_from_pdf(file_bytes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not extracted_text.strip():
        raise HTTPException(
            status_code=422,
            detail=(
                "No readable text was found in this PDF. It may be a scanned or "
                "image-only document. Please upload a PDF with selectable text."
            ),
        )

    # --- Generate script (Multi-provider with automatic fallback) -----------
    # Now supports: Gemini -> Groq -> OpenRouter -> Cerebras -> HuggingFace -> Ollama -> Local
    # If Gemini hits quota (429), it auto-falls back to next free provider.
    # If NO keys set, local fallback ensures it still works unlimited.
    try:
        script, provider_used = generate_script_with_provider(extracted_text)
    except ValueError as exc:
        # Should rarely happen since local fallback always works, but handle
        msg = str(exc)
        if "quota" in msg.lower() or "limit" in msg.lower() or "429" in msg:
            msg += " Tip: Set GROQ_API_KEY (free at console.groq.com) or LLM_PROVIDER=local for unlimited offline."
        raise HTTPException(status_code=502, detail=msg) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Script generation failed: {exc}. Try setting GROQ_API_KEY or LLM_PROVIDER=local"
        ) from exc

    # --- Synthesize audio (Edge-TTS) --------------------------------------
    audio_base64: Optional[str] = None
    audio_error: Optional[str] = None
    try:
        audio_bytes = generate_audio_bytes(script)
        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    except ValueError as exc:
        audio_error = str(exc)
    except Exception as exc:
        audio_error = f"Audio synthesis failed: {exc}"

    payload: dict = {"script": script, "audio_base64": audio_base64, "provider": provider_used}
    if audio_error:
        payload["audio_error"] = audio_error
    # Add helpful note if fallback was used
    if provider_used == "local":
        payload["provider_note"] = "Generated with local fallback (no API) - unlimited. For higher quality, set GROQ_API_KEY (free)."
    elif provider_used != "gemini":
        payload["provider_note"] = f"Generated with {provider_used} (Gemini alternative) - free tier."

    return JSONResponse(status_code=200, content=payload)
