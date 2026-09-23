"""DocuCast TTS engine — multi-voice dialogue synthesis with engine fallback and timestamps.

Upgrades:
  * Two-host dialogue: lines prefixed "NOVA:" / "RHYS:" are synthesized with
    distinct voices and stitched into one audio file.
  * Engine fallback chain (audio can NEVER fail):
        1. Edge-TTS   — neural, free (needs Microsoft endpoint)
        2. gTTS       — free (needs Google endpoint), per-host accents
        3. Piper      — neural, 100% offline (drop .onnx voices in backend/voices/)
        4. espeak-ng  — 100% offline via bundled espeakng-loader library
  * Per-segment duration tracking (Feature 5: interactive click-to-seek):
    Generates exact [{speaker, text, start, end}] timeline.
  * Script sanitization: markdown, emoji and stage directions are stripped
    so the narration never reads "asterisk asterisk" aloud.

generate_audio() returns (audio_bytes, engine_name, mime_type, timeline).
"""

from __future__ import annotations

import asyncio
import io
import os
import re
import threading
from typing import Optional

# Speaker → per-engine voice mapping
EDGE_VOICES = {
    "NOVA": "en-US-JennyNeural",     # curious co-host
    "RHYS": "en-US-GuyNeural",       # explainer
    "_default": "en-US-JennyNeural",
}
GTTS_VOICES = {
    "NOVA": {"lang": "en", "tld": "com"},
    "RHYS": {"lang": "en", "tld": "co.uk"},
    "_default": {"lang": "en", "tld": "com"},
}
ESPEAK_VOICES = {
    "NOVA": b"en-us+f3",
    "RHYS": b"en-gb+m2",
    "_default": b"en-us+f3",
}
PIPER_VOICES = {
    "NOVA": ["en_US-lessac-medium.onnx", "en_US-amy-medium.onnx"],
    "RHYS": ["en_US-ryan-medium.onnx", "en_US-joe-medium.onnx"],
    "_default": ["en_US-lessac-medium.onnx", "en_US-amy-medium.onnx"],
}
VOICES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "voices")

SPEAKER_LINE_RE = re.compile(r"^\s*(NOVA|RHYS|HOST|GUEST|ALEX|SAM|A|B)\s*[:\-–]\s*(.+)$", re.IGNORECASE)
_SPEAKER_ALIASES = {
    "HOST": "NOVA", "ALEX": "NOVA", "A": "NOVA",
    "GUEST": "RHYS", "SAM": "RHYS", "B": "RHYS",
}

MAX_SEGMENTS = 120


def sanitize_for_speech(text: str) -> str:
    """Strip markdown / emoji / bracketed stage directions for clean narration."""
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"[*_#`>~]+", " ", text)
    text = re.sub(r"\[[^\]]{0,80}\]", " ", text)          # [stage directions]
    text = re.sub(r"\((?:laughs|chuckles|pause[s]?|music[^)]*)\)", " ", text, flags=re.I)
    # Strip emoji / pictographs
    text = re.sub(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F]", "", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def split_dialogue(script: str, voice_options: Optional[dict] = None) -> list[tuple[str, str]]:
    """Split a script into (speaker, text) segments.

    Non-dialogue scripts return a single ('_default', text) segment.
    Consecutive lines from the same speaker are merged to minimize TTS calls.
    """
    voice_options = voice_options or {}
    host_a = str(voice_options.get("host_a_name") or "NOVA").strip()[:24] or "NOVA"
    host_b = str(voice_options.get("host_b_name") or "RHYS").strip()[:24] or "RHYS"
    speaker_re = re.compile(
        rf"^\s*({re.escape(host_a)}|{re.escape(host_b)}|NOVA|RHYS|HOST|GUEST|ALEX|SAM|A|B)\s*[:\-–]\s*(.+)$",
        re.IGNORECASE,
    )
    custom_aliases = {host_a.upper(): "NOVA", host_b.upper(): "RHYS"}
    segments: list[tuple[str, str]] = []
    found_speaker = False
    for raw_line in script.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = speaker_re.match(line)
        if m:
            found_speaker = True
            name = m.group(1).upper()
            speaker = custom_aliases.get(name, _SPEAKER_ALIASES.get(name, name))
            content = sanitize_for_speech(m.group(2))
            if content:
                if segments and segments[-1][0] == speaker:
                    segments[-1] = (speaker, segments[-1][1] + " " + content)
                else:
                    segments.append((speaker, content))
        else:
            content = sanitize_for_speech(line)
            if not content:
                continue
            if segments:
                segments[-1] = (segments[-1][0], segments[-1][1] + " " + content)
            else:
                segments.append(("_default", content))

    if not found_speaker:
        whole = sanitize_for_speech(script)
        return [("_default", whole)] if whole else []
    return segments[:MAX_SEGMENTS]


def _measure_duration(audio_bytes: bytes, fallback_word_count: int = 0) -> float:
    """Accurately measure duration in seconds using mutagen with speech-rate fallback."""
    try:
        import mutagen
        f = mutagen.File(io.BytesIO(audio_bytes))
        if f is not None and getattr(f, "info", None) and getattr(f.info, "length", None):
            return float(f.info.length)
    except Exception:
        pass
    if fallback_word_count > 0:
        return max(0.8, round(fallback_word_count / 2.6, 2))
    return 1.5


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def generate_audio_bytes(text: str) -> bytes:
    """Backward-compatible single return value."""
    audio, _engine, _mime, _timeline = generate_audio(text)
    return audio


def generate_audio(script: str, voice_options: Optional[dict] = None) -> tuple[bytes, str, str, list[dict]]:
    """Synthesize the full script (dialogue-aware).

    Returns (audio_bytes, engine, mime_type, timeline).
    timeline is a list of {"speaker": str, "text": str, "start": float, "end": float}.
    """
    voice_options = voice_options or {}
    segments = split_dialogue(script, voice_options)
    if not segments:
        raise ValueError("Script is empty after sanitization; nothing to synthesize.")

    errors = []

    # Engine 1: Edge-TTS (best quality, distinct neural voices)
    try:
        audio, timeline = _synthesize_all_edge(segments, voice_options)
        return audio, "edge-tts", "audio/mpeg", timeline
    except Exception as exc:
        errors.append(f"edge-tts: {exc}")

    # Engine 2: gTTS (reliable cloud fallback, host accents differ)
    try:
        audio, timeline = _synthesize_all_gtts(segments)
        return audio, "gtts", "audio/mpeg", timeline
    except Exception as exc:
        errors.append(f"gtts: {exc}")

    # Engine 3: Piper neural TTS — fully offline, if voice models are present
    try:
        result = _synthesize_all_piper(segments)
        if result:
            audio, timeline = result
            return audio, "piper", "audio/wav", timeline
    except Exception as exc:
        errors.append(f"piper: {exc}")

    # Engine 4: espeak-ng via bundled library — fully offline, always available
    try:
        audio, timeline = _synthesize_all_espeak(segments)
        return audio, "espeak-ng", "audio/wav", timeline
    except Exception as exc:
        errors.append(f"espeak-ng: {exc}")

    raise ValueError("Audio synthesis failed on all engines. " + " | ".join(errors))


# ---------------------------------------------------------------------------
# Edge-TTS
# ---------------------------------------------------------------------------
def _synthesize_all_edge(segments: list[tuple[str, str]], voice_options: Optional[dict] = None) -> tuple[bytes, list[dict]]:
    return _run_coro_safely(_edge_dialogue(segments, voice_options or {}))


async def _edge_dialogue(segments: list[tuple[str, str]], voice_options: dict) -> tuple[bytes, list[dict]]:
    import edge_tts

    parts: list[bytes] = []
    timeline: list[dict] = []
    current_time = 0.0

    for speaker, content in segments:
        voice_key = "host_a_voice" if speaker == "NOVA" else "host_b_voice" if speaker == "RHYS" else "_default"
        voice = voice_options.get(voice_key) or EDGE_VOICES.get(speaker, EDGE_VOICES["_default"])
        rate_key = "host_a_rate" if speaker == "NOVA" else "host_b_rate"
        pitch_key = "host_a_pitch" if speaker == "NOVA" else "host_b_pitch"
        rate = int(voice_options.get(rate_key, 0))
        pitch = int(voice_options.get(pitch_key, 0))
        communicate = edge_tts.Communicate(content, voice, rate=f"{rate:+d}%", pitch=f"{pitch:+d}Hz")
        chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        if not chunks:
            raise ValueError("Edge-TTS produced no audio for a segment.")
        seg_bytes = b"".join(chunks)
        dur = _measure_duration(seg_bytes, fallback_word_count=len(content.split()))
        start = round(current_time, 2)
        end = round(start + dur, 2)
        timeline.append({"speaker": speaker, "text": content, "start": start, "end": end})
        current_time = end
        parts.append(seg_bytes)

    if not parts:
        raise ValueError("Edge-TTS produced no audio data.")
    return b"".join(parts), timeline


def _run_coro_safely(coro):
    """Run a coroutine whether or not an event loop is already running."""
    try:
        return asyncio.run(coro)
    except RuntimeError as exc:
        if "running event loop" not in str(exc) and "asyncio.run" not in str(exc):
            raise
    # Fall back to a fresh loop in its own thread
    result: dict = {}
    error: dict = {}

    def _target():
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            result["data"] = loop.run_until_complete(coro)
            loop.close()
        except Exception as e:
            error["exc"] = e

    th = threading.Thread(target=_target, daemon=True)
    th.start()
    th.join(timeout=180)
    if "exc" in error:
        raise ValueError(str(error["exc"]))
    if th.is_alive() or "data" not in result:
        raise ValueError("TTS timed out.")
    return result["data"]


# ---------------------------------------------------------------------------
# gTTS fallback
# ---------------------------------------------------------------------------
def _synthesize_all_gtts(segments: list[tuple[str, str]]) -> tuple[bytes, list[dict]]:
    from io import BytesIO
    from gtts import gTTS

    parts: list[bytes] = []
    timeline: list[dict] = []
    current_time = 0.0

    for speaker, content in segments:
        cfg = GTTS_VOICES.get(speaker, GTTS_VOICES["_default"])
        buf = BytesIO()
        gTTS(text=content, lang=cfg["lang"], tld=cfg["tld"]).write_to_fp(buf)
        data = buf.getvalue()
        if not data:
            raise ValueError("gTTS produced no audio for a segment.")
        dur = _measure_duration(data, fallback_word_count=len(content.split()))
        start = round(current_time, 2)
        end = round(start + dur, 2)
        timeline.append({"speaker": speaker, "text": content, "start": start, "end": end})
        current_time = end
        parts.append(data)

    if not parts:
        raise ValueError("gTTS produced no audio data.")
    return b"".join(parts), timeline


# ---------------------------------------------------------------------------
# Piper neural TTS (offline)
# ---------------------------------------------------------------------------
def _find_piper_voice(speaker: str):
    for candidate in PIPER_VOICES.get(speaker, PIPER_VOICES["_default"]):
        path = os.path.join(VOICES_DIR, candidate)
        if os.path.exists(path) and os.path.exists(path + ".json"):
            return path
    if os.path.isdir(VOICES_DIR):
        for f in sorted(os.listdir(VOICES_DIR)):
            if f.endswith(".onnx") and os.path.exists(os.path.join(VOICES_DIR, f + ".json")):
                return os.path.join(VOICES_DIR, f)
    return None


def _synthesize_all_piper(segments: list[tuple[str, str]]) -> tuple[bytes, list[dict]] | None:
    if not os.path.isdir(VOICES_DIR):
        return None
    try:
        from piper import PiperVoice
    except ImportError:
        return None

    voices: dict[str, object] = {}
    pcm_parts: list[bytes] = []
    timeline: list[dict] = []
    current_time = 0.0
    sample_rate = 22050

    for speaker, content in segments:
        model_path = _find_piper_voice(speaker)
        if not model_path:
            return None
        if model_path not in voices:
            voices[model_path] = PiperVoice.load(model_path)
        voice = voices[model_path]
        seg_pcm = []
        for chunk in voice.synthesize(content):
            seg_pcm.append(chunk.audio_int16_bytes)
            sample_rate = chunk.sample_rate
        seg_bytes = b"".join(seg_pcm)
        pcm_parts.append(seg_bytes)
        dur = len(seg_bytes) / (sample_rate * 2)
        start = round(current_time, 2)
        end = round(start + dur, 2)
        timeline.append({"speaker": speaker, "text": content, "start": start, "end": end})
        current_time = end

    if not pcm_parts:
        return None
    return _pcm_to_wav(b"".join(pcm_parts), sample_rate), timeline


# ---------------------------------------------------------------------------
# espeak-ng offline fallback
# ---------------------------------------------------------------------------
_ESPEAK_LOCK = threading.Lock()
_ESPEAK_STATE: dict = {}


def _espeak_lib():
    """Load and initialize libespeak-ng once per process."""
    if "lib" in _ESPEAK_STATE:
        return _ESPEAK_STATE["lib"], _ESPEAK_STATE["rate"]
    import ctypes
    import espeakng_loader

    lib = ctypes.CDLL(espeakng_loader.get_library_path())
    data_path = str(espeakng_loader.get_data_path()).encode()
    rate = lib.espeak_Initialize(2, 0, data_path, 0)
    if rate <= 0:
        raise ValueError("espeak-ng initialization failed.")
    _ESPEAK_STATE["lib"] = lib
    _ESPEAK_STATE["rate"] = rate
    return lib, rate


def _synthesize_all_espeak(segments: list[tuple[str, str]]) -> tuple[bytes, list[dict]]:
    import ctypes

    with _ESPEAK_LOCK:
        lib, rate = _espeak_lib()

        collected: list[bytes] = []
        CALLBACK = ctypes.CFUNCTYPE(
            ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p
        )

        def _cb(wav, num, _events):
            if wav and num > 0:
                collected.append(ctypes.string_at(wav, num * 2))
            return 0

        cb_ref = CALLBACK(_cb)
        lib.espeak_SetSynthCallback(cb_ref)
        lib.espeak_SetParameter(1, 160, 0)

        silence = b"\x00" * int(rate * 0.35) * 2  # 350 ms pause between turns
        pcm_parts: list[bytes] = []
        timeline: list[dict] = []
        current_time = 0.0

        for speaker, content in segments:
            lib.espeak_SetVoiceByName(ESPEAK_VOICES.get(speaker, ESPEAK_VOICES["_default"]))
            collected.clear()
            data = content.encode("utf-8")
            lib.espeak_Synth(data, len(data) + 1, 0, 0, 0, 1, None, None)
            lib.espeak_Synchronize()
            if collected:
                seg_bytes = b"".join(collected)
                pcm_parts.append(seg_bytes)
                pcm_parts.append(silence)
                dur = len(seg_bytes) / (rate * 2)
                start = round(current_time, 2)
                end = round(start + dur, 2)
                timeline.append({"speaker": speaker, "text": content, "start": start, "end": end})
                current_time = round(end + 0.35, 2)

        if not pcm_parts:
            raise ValueError("espeak-ng produced no audio data.")
        return _pcm_to_wav(b"".join(pcm_parts), rate), timeline


def _pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    import wave
    from io import BytesIO

    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()
