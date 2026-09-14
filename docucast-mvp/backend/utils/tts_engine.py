"""DocuCast TTS engine — multi-voice dialogue synthesis with engine fallback.

Upgrades over the original single-voice module:

  * Two-host dialogue: lines prefixed "NOVA:" / "RHYS:" are synthesized with
    distinct voices and stitched into one audio file — a real conversation,
    not a monologue.
  * Engine fallback chain (audio can NEVER fail):
        1. Edge-TTS   — neural, free (needs Microsoft endpoint)
        2. gTTS       — free (needs Google endpoint), per-host accents
        3. Piper      — neural, 100% offline (drop .onnx voices in backend/voices/)
        4. espeak-ng  — 100% offline via the bundled espeakng-loader library,
                        zero network, zero external binaries. Robotic but
                        guarantees a podcast always ships with audio.
  * Script sanitization: markdown, emoji and stage directions are stripped
    so the narration never reads "asterisk asterisk" aloud.

generate_audio() returns (audio_bytes, engine_name, mime_type).
"""

from __future__ import annotations

import asyncio
import os
import re
import threading

# Speaker → per-engine voice mapping
EDGE_VOICES = {
    "NOVA": "en-US-JennyNeural",     # curious co-host
    "RHYS": "en-US-GuyNeural",       # explainer
    "_default": "en-US-JennyNeural",
}
EDGE_VOICES_BY_LANGUAGE = {
    "en": EDGE_VOICES,
    "hi": {"NOVA": "hi-IN-SwaraNeural", "RHYS": "hi-IN-MadhurNeural", "_default": "hi-IN-SwaraNeural"},
    "es": {"NOVA": "es-ES-ElviraNeural", "RHYS": "es-ES-AlvaroNeural", "_default": "es-ES-ElviraNeural"},
    "fr": {"NOVA": "fr-FR-DeniseNeural", "RHYS": "fr-FR-HenriNeural", "_default": "fr-FR-DeniseNeural"},
    "de": {"NOVA": "de-DE-KatjaNeural", "RHYS": "de-DE-ConradNeural", "_default": "de-DE-KatjaNeural"},
    "pt": {"NOVA": "pt-BR-FranciscaNeural", "RHYS": "pt-BR-AntonioNeural", "_default": "pt-BR-FranciscaNeural"},
    "ja": {"NOVA": "ja-JP-NanamiNeural", "RHYS": "ja-JP-KeitaNeural", "_default": "ja-JP-NanamiNeural"},
}
GTTS_VOICES = {
    # gTTS has one voice per accent; use different accents to distinguish hosts
    "NOVA": {"lang": "en", "tld": "com"},
    "RHYS": {"lang": "en", "tld": "co.uk"},
    "_default": {"lang": "en", "tld": "com"},
}
GTTS_LANGUAGE_CODES = {"en": "en", "hi": "hi", "es": "es", "fr": "fr", "de": "de", "pt": "pt", "ja": "ja"}
ESPEAK_VOICES = {
    "NOVA": b"en-us+f3",
    "RHYS": b"en-gb+m2",
    "_default": b"en-us+f3",
}
ESPEAK_VOICES_BY_LANGUAGE = {
    "en": ESPEAK_VOICES,
    "hi": {"NOVA": b"hi+f3", "RHYS": b"hi+m2", "_default": b"hi+f3"},
    "es": {"NOVA": b"es+f3", "RHYS": b"es+m2", "_default": b"es+f3"},
    "fr": {"NOVA": b"fr-fr+f3", "RHYS": b"fr-fr+m2", "_default": b"fr-fr+f3"},
    "de": {"NOVA": b"de+f3", "RHYS": b"de+m2", "_default": b"de+f3"},
    "pt": {"NOVA": b"pt+f3", "RHYS": b"pt+m2", "_default": b"pt+f3"},
    "ja": {"NOVA": b"ja+f3", "RHYS": b"ja+m2", "_default": b"ja+f3"},
}
# Piper: filenames looked up inside VOICES_DIR (any of these that exist)
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

# Generous cap: a "deep" dialogue script is ~60-80 short turns. Beyond this,
# remaining turns are dropped from audio only — synthesize fewer, longer turns.
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


def split_dialogue(script: str) -> list[tuple[str, str]]:
    """Split a script into (speaker, text) segments.

    Non-dialogue scripts return a single ('_default', text) segment.
    Consecutive lines from the same speaker are merged to minimize TTS calls.
    """
    segments: list[tuple[str, str]] = []
    found_speaker = False
    for raw_line in script.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = SPEAKER_LINE_RE.match(line)
        if m:
            found_speaker = True
            name = m.group(1).upper()
            speaker = _SPEAKER_ALIASES.get(name, name)
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def generate_audio_bytes(text: str, language: str = "en") -> bytes:
    """Backward-compatible single return value."""
    audio, _engine, _mime = generate_audio(text, language)
    return audio


def generate_audio(script: str, language: str = "en") -> tuple[bytes, str, str]:
    """Synthesize the full script (dialogue-aware).

    Returns (audio_bytes, engine, mime_type). Raises ValueError only if every
    engine — including the fully-offline ones — fails.
    """
    segments = split_dialogue(script)
    if not segments:
        raise ValueError("Script is empty after sanitization; nothing to synthesize.")

    errors = []

    # Engine 1: Edge-TTS (best quality, distinct neural voices)
    try:
        return _synthesize_all_edge(segments, language), "edge-tts", "audio/mpeg"
    except Exception as exc:
        errors.append(f"edge-tts: {exc}")

    # Engine 2: gTTS (reliable cloud fallback, host accents differ)
    try:
        return _synthesize_all_gtts(segments, language), "gtts", "audio/mpeg"
    except Exception as exc:
        errors.append(f"gtts: {exc}")

    # Engine 3: Piper neural TTS — fully offline, if voice models are present
    try:
        # Bundled Piper voices are English-only. Avoid an inaccurate voice for
        # translated narration and continue to the language-capable fallback.
        audio = _synthesize_all_piper(segments) if language == "en" else None
        if audio:
            return audio, "piper", "audio/wav"
    except Exception as exc:
        errors.append(f"piper: {exc}")

    # Engine 4: espeak-ng via bundled library — fully offline, always available
    try:
        return _synthesize_all_espeak(segments, language), "espeak-ng", "audio/wav"
    except Exception as exc:
        errors.append(f"espeak-ng: {exc}")

    raise ValueError("Audio synthesis failed on all engines. " + " | ".join(errors))


# ---------------------------------------------------------------------------
# Edge-TTS
# ---------------------------------------------------------------------------
def _synthesize_all_edge(segments: list[tuple[str, str]], language: str = "en") -> bytes:
    return _run_coro_safely(_edge_dialogue(segments, language))


async def _edge_dialogue(segments: list[tuple[str, str]], language: str = "en") -> bytes:
    import edge_tts

    parts: list[bytes] = []
    for speaker, content in segments:
        voices = EDGE_VOICES_BY_LANGUAGE.get(language, EDGE_VOICES)
        voice = voices.get(speaker, voices["_default"])
        communicate = edge_tts.Communicate(content, voice)
        chunks: list[bytes] = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        if not chunks:
            raise ValueError("Edge-TTS produced no audio for a segment.")
        parts.append(b"".join(chunks))
    if not parts:
        raise ValueError("Edge-TTS produced no audio data.")
    return b"".join(parts)


def _run_coro_safely(coro) -> bytes:
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
        except Exception as e:  # pragma: no cover
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
def _synthesize_all_gtts(segments: list[tuple[str, str]], language: str = "en") -> bytes:
    from io import BytesIO

    from gtts import gTTS

    parts: list[bytes] = []
    for speaker, content in segments:
        cfg = GTTS_VOICES.get(speaker, GTTS_VOICES["_default"])
        lang = GTTS_LANGUAGE_CODES.get(language, "en")
        buf = BytesIO()
        gTTS(text=content, lang=lang, tld=cfg["tld"] if lang == "en" else "com").write_to_fp(buf)
        data = buf.getvalue()
        if not data:
            raise ValueError("gTTS produced no audio for a segment.")
        parts.append(data)
    if not parts:
        raise ValueError("gTTS produced no audio data.")
    return b"".join(parts)


# ---------------------------------------------------------------------------
# Piper neural TTS (offline; needs .onnx voices in backend/voices/)
# ---------------------------------------------------------------------------
def _find_piper_voice(speaker: str):
    for candidate in PIPER_VOICES.get(speaker, PIPER_VOICES["_default"]):
        path = os.path.join(VOICES_DIR, candidate)
        if os.path.exists(path) and os.path.exists(path + ".json"):
            return path
    # Any onnx voice at all?
    if os.path.isdir(VOICES_DIR):
        for f in sorted(os.listdir(VOICES_DIR)):
            if f.endswith(".onnx") and os.path.exists(os.path.join(VOICES_DIR, f + ".json")):
                return os.path.join(VOICES_DIR, f)
    return None


def _synthesize_all_piper(segments: list[tuple[str, str]]) -> bytes | None:
    if not os.path.isdir(VOICES_DIR):
        return None
    try:
        from piper import PiperVoice
    except ImportError:
        return None

    voices: dict[str, object] = {}
    pcm_parts: list[bytes] = []
    sample_rate = 22050
    for speaker, content in segments:
        model_path = _find_piper_voice(speaker)
        if not model_path:
            return None
        if model_path not in voices:
            voices[model_path] = PiperVoice.load(model_path)
        voice = voices[model_path]
        for chunk in voice.synthesize(content):
            pcm_parts.append(chunk.audio_int16_bytes)
            sample_rate = chunk.sample_rate
    if not pcm_parts:
        return None
    return _pcm_to_wav(b"".join(pcm_parts), sample_rate)


# ---------------------------------------------------------------------------
# espeak-ng offline fallback (bundled shared library — zero network)
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
    rate = lib.espeak_Initialize(2, 0, data_path, 0)  # AUDIO_OUTPUT_SYNCHRONOUS
    if rate <= 0:
        raise ValueError("espeak-ng initialization failed.")
    _ESPEAK_STATE["lib"] = lib
    _ESPEAK_STATE["rate"] = rate
    return lib, rate


def _synthesize_all_espeak(segments: list[tuple[str, str]], language: str = "en") -> bytes:
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

        cb_ref = CALLBACK(_cb)  # keep a reference alive during synthesis
        lib.espeak_SetSynthCallback(cb_ref)
        # Slightly slower rate reads more naturally for narration
        lib.espeak_SetParameter(1, 160, 0)  # espeakRATE

        silence = b"\x00" * int(rate * 0.35) * 2  # 350 ms pause between turns
        pcm_parts: list[bytes] = []
        for speaker, content in segments:
            voices = ESPEAK_VOICES_BY_LANGUAGE.get(language, ESPEAK_VOICES)
            lib.espeak_SetVoiceByName(voices.get(speaker, voices["_default"]))
            collected.clear()
            data = content.encode("utf-8")
            lib.espeak_Synth(data, len(data) + 1, 0, 0, 0, 1, None, None)  # POS_CHARACTER, espeakCHARS_UTF8
            lib.espeak_Synchronize()
            if collected:
                pcm_parts.append(b"".join(collected))
                pcm_parts.append(silence)

        if not pcm_parts:
            raise ValueError("espeak-ng produced no audio data.")
        return _pcm_to_wav(b"".join(pcm_parts), rate)


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
