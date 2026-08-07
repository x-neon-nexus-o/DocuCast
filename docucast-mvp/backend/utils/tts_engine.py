"""Edge-TTS audio generation for DocuCast MVP - with robust event loop handling."""

import asyncio
import threading

import edge_tts

VOICE = "en-US-JennyNeural"


def generate_audio_bytes(text: str) -> bytes:
    """Synthesize MP3 audio bytes from the given script.

    Handles both sync and async contexts (uvicorn, tests, etc).
    Tries asyncio.run, falls back to new loop in thread if needed.
    For TTS failures, caller in main.py will still return script with audio_error.

    Raises:
        ValueError: If TTS synthesis fails.
    """
    try:
        # Try normal case: no loop running (uvicorn sync handler)
        return asyncio.run(_synthesize(text))
    except RuntimeError as exc:
        # If we're inside an already-running loop (e.g. pytest, async test)
        # create a new loop in a separate thread
        if "cannot be called from a running event loop" in str(exc) or "asyncio.run" in str(exc):
            return _run_in_new_thread(text)
        raise ValueError(f"Audio synthesis failed: {exc}") from exc
    except Exception as exc:
        raise ValueError(f"Audio synthesis failed: {exc}") from exc


def _run_in_new_thread(text: str) -> bytes:
    """Run TTS in a fresh thread with its own event loop."""
    result = {}
    error = {}

    def _thread_target():
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            result["data"] = loop.run_until_complete(_synthesize(text))
            loop.close()
        except Exception as e:
            error["exc"] = e

    th = threading.Thread(target=_thread_target, daemon=True)
    th.start()
    th.join(timeout=60)
    if "exc" in error:
        raise ValueError(f"Audio synthesis failed: {error['exc']}")
    if th.is_alive():
        raise ValueError("Audio synthesis timed out")
    if "data" not in result:
        raise ValueError("TTS produced no audio data.")
    return result["data"]


async def _synthesize(text: str) -> bytes:
    # Edge-TTS can be slow or fail if MS endpoint changes - handle gracefully
    communicate = edge_tts.Communicate(text, VOICE)
    audio_chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])
    if not audio_chunks:
        raise ValueError("TTS produced no audio data.")
    return b"".join(audio_chunks)


# Alternative TTS for when Edge-TTS is blocked (free, offline fallback note)
# If needed, could swap to gTTS or pyttsx3 here.
# gTTS example: from gtts import gTTS; gTTS(text, lang='en').save(...)
