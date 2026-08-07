"""FastAPI entrypoint for DocuCast MVP."""

import base64
import os
import time
from collections import defaultdict, deque
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from utils.pdf_parser import extract_text_from_pdf
from utils.script_generator import generate_script
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
    ]
    if origin
]

app = FastAPI(title="DocuCast MVP", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # First IP in the chain is the original client.
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _check_throttle(ip: str) -> None:
    now = time.time()
    log = _request_log[ip]
    # Drop entries outside the window.
    while log and now - log[0] > THROTTLE_WINDOW_SECONDS:
        log.popleft()
    if len(log) >= THROTTLE_MAX_REQUESTS:
        retry_after = int(THROTTLE_WINDOW_SECONDS - (now - log[0])) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Too many requests. Please try again in {retry_after} seconds.",
        )
    log.append(now)


@app.get("/")
def health() -> dict:
    return {"status": "ok", "service": "DocuCast MVP"}


@app.post("/generate")
async def generate(
    request: Request,
    file: UploadFile = File(...),
) -> JSONResponse:
    client_ip = _client_ip(request)
    _check_throttle(client_ip)

    # --- Validate file type ------------------------------------------------
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are accepted. Please upload a .pdf file.",
        )

    # --- Read file (with size cap) -----------------------------------------
    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(file_bytes) > MAX_FILE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="File exceeds the 10 MB limit. Please upload a smaller PDF.",
        )

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        # Secondary check in case content-type was spoofed/omitted.
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

    # --- Generate script (Gemini) -----------------------------------------
    try:
        api_key = os.getenv("GEMINI_API_KEY", "")
        script = generate_script(extracted_text, api_key)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(
            status_code=502, detail=f"Script generation failed: {exc}"
        ) from exc

    # --- Synthesize audio (Edge-TTS) --------------------------------------
    # Wrapped independently so a TTS failure does not discard the script.
    audio_base64: Optional[str] = None
    audio_error: Optional[str] = None
    try:
        audio_bytes = generate_audio_bytes(script)
        audio_base64 = base64.b64encode(audio_bytes).decode("ascii")
    except ValueError as exc:
        audio_error = str(exc)
    except Exception as exc:  # pragma: no cover - defensive
        audio_error = f"Audio synthesis failed: {exc}"

    payload: dict = {"script": script, "audio_base64": audio_base64}
    if audio_error:
        payload["audio_error"] = audio_error

    return JSONResponse(status_code=200, content=payload)
