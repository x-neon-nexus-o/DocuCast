"""Edge-TTS audio generation for DocuCast MVP."""

import asyncio

import edge_tts

VOICE = "en-US-JennyNeural"


def generate_audio_bytes(text: str) -> bytes:
    """Synthesize MP3 audio bytes from the given script.

    Runs the async edge-tts Communicate inside a dedicated event loop so this
    function can be called from synchronous FastAPI request handlers.

    Raises:
        ValueError: If TTS synthesis fails.
    """
    try:
        return asyncio.run(_synthesize(text))
    except Exception as exc:
        raise ValueError(f"Audio synthesis failed: {exc}") from exc


async def _synthesize(text: str) -> bytes:
    communicate = edge_tts.Communicate(text, VOICE)
    audio_chunks = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio_chunks.append(chunk["data"])
    if not audio_chunks:
        raise ValueError("TTS produced no audio data.")
    return b"".join(audio_chunks)
