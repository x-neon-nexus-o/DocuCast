"""Optional image intelligence for DocuCast: OCR + vision-LLM descriptions.

Every function degrades gracefully — if no OCR binary or vision-capable API
key is available, callers receive None and the parser reports the image with
heuristics instead of failing.

Providers tried for vision (first available wins):
  1. Gemini (GEMINI_API_KEY)            - multimodal flash models
  2. OpenRouter free vision models      - OPENROUTER_API_KEY
  3. Ollama (llava / moondream local)   - OLLAMA_HOST

OCR: pytesseract, only when the tesseract binary exists on the host.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
from collections import OrderedDict
from typing import Optional

_VISION_CACHE: OrderedDict[str, Optional[dict]] = OrderedDict()
_VISION_CACHE_MAX = 128
_VISION_DISABLED = False  # trips after repeated hard failures to avoid slow uploads
_VISION_FAILURES = 0
_MAX_VISION_FAILURES = 3

VISION_PROMPT = (
    "You are analyzing an image extracted from a document for a podcast. "
    "Reply ONLY with compact JSON: "
    '{"kind": one of ["photo","graph/chart","figure/diagram","table image","handwritten note","screenshot","equation","other"], '
    '"description": 1-3 sentences saying what the image shows and, if it is a chart/graph, the trend and key values, '
    '"text": any readable text transcribed from the image (including handwriting), '
    '"handwritten": true/false whether it contains handwriting}. '
)


# ---------------------------------------------------------------------------
# OCR
# ---------------------------------------------------------------------------
def ocr_available() -> bool:
    if shutil.which("tesseract") is None:
        return False
    try:
        import pytesseract  # noqa: F401
        return True
    except ImportError:
        return False


def ocr_image(image_bytes: bytes) -> Optional[str]:
    """Extract text from an image via tesseract, or None when unavailable."""
    if not ocr_available():
        return None
    try:
        import io

        import pytesseract
        from PIL import Image

        with Image.open(io.BytesIO(image_bytes)) as im:
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            text = pytesseract.image_to_string(im, timeout=15)
        text = re.sub(r"\s+", " ", text or "").strip()
        return text if len(text) > 3 else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Vision LLM
# ---------------------------------------------------------------------------
def vision_available() -> dict:
    """Which vision providers are configured (for /providers endpoint)."""
    return {
        "gemini_vision": bool(os.getenv("GEMINI_API_KEY")),
        "openrouter_vision": bool(os.getenv("OPENROUTER_API_KEY")),
        "ollama_vision": bool(os.getenv("OLLAMA_HOST")),
        "ocr": ocr_available(),
    }


def describe_image(image_bytes: bytes, context_hint: str = "") -> Optional[dict]:
    """Ask a vision LLM what's inside the image.

    Returns {"kind", "description", "text", "handwritten"} or None.
    Results are cached per-image within the process.
    """
    global _VISION_DISABLED, _VISION_FAILURES
    if _VISION_DISABLED:
        return None

    import hashlib

    key = hashlib.sha1(image_bytes[:65536]).hexdigest()
    if key in _VISION_CACHE:
        _VISION_CACHE.move_to_end(key)
        return _VISION_CACHE[key]

    result = None
    for fn in (_vision_gemini, _vision_openrouter, _vision_ollama):
        try:
            result = fn(image_bytes, context_hint)
            if result:
                break
        except Exception:
            continue

    if result is None and any(
        [os.getenv("GEMINI_API_KEY"), os.getenv("OPENROUTER_API_KEY"), os.getenv("OLLAMA_HOST")]
    ):
        _VISION_FAILURES += 1
        if _VISION_FAILURES >= _MAX_VISION_FAILURES:
            _VISION_DISABLED = True

    _VISION_CACHE[key] = result
    while len(_VISION_CACHE) > _VISION_CACHE_MAX:
        _VISION_CACHE.popitem(last=False)
    return result


def _parse_vision_json(raw: str) -> Optional[dict]:
    if not raw:
        return None
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        # Treat the free-form answer as a plain description
        clean = raw.strip()
        return {"kind": None, "description": clean[:500], "text": None, "handwritten": "handwrit" in clean.lower()} if clean else None
    try:
        data = json.loads(m.group(0))
    except Exception:
        return {"kind": None, "description": raw.strip()[:500], "text": None, "handwritten": False}
    return {
        "kind": (data.get("kind") or None),
        "description": (data.get("description") or "").strip()[:600] or None,
        "text": (data.get("text") or "").strip()[:800] or None,
        "handwritten": bool(data.get("handwritten")),
    }


def _guess_mime(image_bytes: bytes) -> str:
    if image_bytes[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if image_bytes[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if image_bytes[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        return "image/webp"
    return "image/png"


def _vision_gemini(image_bytes: bytes, context_hint: str) -> Optional[dict]:
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        return None
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    prompt = VISION_PROMPT
    if context_hint:
        prompt += f"\nNearby document text for context: {context_hint}"

    for model in ("gemini-2.0-flash", "gemini-1.5-flash"):
        try:
            response = client.models.generate_content(
                model=model,
                contents=[
                    types.Part.from_bytes(data=image_bytes, mime_type=_guess_mime(image_bytes)),
                    prompt,
                ],
                config=types.GenerateContentConfig(temperature=0.2, max_output_tokens=400),
            )
            out = _parse_vision_json(getattr(response, "text", "") or "")
            if out:
                return out
        except Exception:
            continue
    return None


def _vision_openrouter(image_bytes: bytes, context_hint: str) -> Optional[dict]:
    api_key = os.getenv("OPENROUTER_API_KEY", "")
    if not api_key:
        return None
    import requests

    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_url = f"data:{_guess_mime(image_bytes)};base64,{b64}"
    prompt = VISION_PROMPT + (f"\nNearby document text: {context_hint}" if context_hint else "")

    for model in ("qwen/qwen2.5-vl-32b-instruct:free", "google/gemma-3-12b-it:free"):
        try:
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    }],
                    "max_tokens": 400,
                    "temperature": 0.2,
                },
                timeout=40,
            )
            resp.raise_for_status()
            out = _parse_vision_json(resp.json()["choices"][0]["message"]["content"])
            if out:
                return out
        except Exception:
            continue
    return None


def _vision_ollama(image_bytes: bytes, context_hint: str) -> Optional[dict]:
    host = os.getenv("OLLAMA_HOST", "").rstrip("/")
    if not host:
        return None
    import requests

    try:
        tags = requests.get(f"{host}/api/tags", timeout=3).json().get("models", [])
    except Exception:
        return None
    vision_models = [m["name"] for m in tags if any(k in m["name"] for k in ("llava", "moondream", "vision", "bakllava"))]
    if not vision_models:
        return None

    b64 = base64.b64encode(image_bytes).decode("ascii")
    prompt = VISION_PROMPT + (f"\nNearby document text: {context_hint}" if context_hint else "")
    try:
        resp = requests.post(
            f"{host}/api/generate",
            json={"model": vision_models[0], "prompt": prompt, "images": [b64], "stream": False},
            timeout=90,
        )
        resp.raise_for_status()
        return _parse_vision_json(resp.json().get("response", ""))
    except Exception:
        return None
