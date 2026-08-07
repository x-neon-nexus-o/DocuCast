"""Multi-provider script generation for DocuCast MVP.

Free & Unlimited Alternatives when Gemini limits are hit.

Supports (in priority order if LLM_PROVIDER=auto):
  1. Gemini (google-genai) - original, free tier but quota-limited
  2. Groq - FREE, 14k requests/day, super fast - RECOMMENDED ALTERNATIVE
  3. OpenRouter - FREE models (qwen, llama, gemma - no credit card)
  4. Cerebras - FREE tier, ultra fast
  5. Hugging Face Inference - FREE
  6. Ollama - 100% FREE, UNLIMITED, OFFLINE, no API key needed
  7. Local Rule-Based Fallback - ALWAYS works, zero API, unlimited

No API key? Local fallback guarantees DocuCast NEVER breaks.

Usage:
  GEMINI_API_KEY=...  -> uses Gemini
  GROQ_API_KEY=...    -> uses Groq (free at https://console.groq.com/keys)
  OPENROUTER_API_KEY=... -> uses OpenRouter free models
  HF_TOKEN=...        -> uses Hugging Face
  OLLAMA_HOST=http://localhost:11434 -> uses local Ollama
  LLM_PROVIDER=auto|gemini|groq|openrouter|cerebras|huggingface|ollama|local

If no keys set, automatically uses local fallback (extractive summarization).
If Gemini hits 429/quota, automatically falls back to next available provider.
"""

import os
import re
from collections import Counter

# ---------------------------------------------------------------------------
# Prompt - same quality as original
# ---------------------------------------------------------------------------
SYSTEM_INSTRUCTION = """You are a professional podcast host explaining complex documents to busy professionals.

Rules:
- Explain ONLY what exists in the document.
- Do NOT add external facts.
- Use simple 8th-grade language.
- Include 1-2 relatable analogies.
- Format as:
  Hook/Intro
  Main Explanation (with analogy)
  Quick Recap
- Keep output under 400 words.
- Tone: Conversational and engaging."""

# The user prompt template
def _build_user_prompt(text: str) -> str:
    return f"Document:\n{text}\n\nGenerate the podcast script now."


# ---------------------------------------------------------------------------
# Local fallback - TF based extractive summarizer + podcast template
# Works with ZERO API, unlimited, offline
# ---------------------------------------------------------------------------
def _local_fallback_podcast(text: str) -> str:
    """Generate a podcast script without any LLM - pure Python.

    Uses word-frequency scoring to pick key sentences, then wraps them
    in a podcast template with a generic analogy. Quality is lower than
    LLM but guarantees the app never fails due to API limits.
    """
    # Clean and split into sentences
    text = text.strip()
    if not text:
        return "Hey there! It looks like we couldn't find much to talk about in this document. Try uploading a PDF with more selectable text."

    # Split on sentence boundaries
    sentences = re.split(r'(?<=[.!?])\s+', text)
    sentences = [s.strip() for s in sentences if len(s.strip()) > 20]
    
    if not sentences:
        sentences = [text[:500]]

    # Simple word frequency scoring (remove stopwords)
    stopwords = {
        'the','a','an','and','or','but','in','on','at','to','for','of','with','by','is','are','was','were','be','been','being',
        'have','has','had','do','does','did','will','would','could','should','may','might','must','shall','can','this','that',
        'these','those','it','its','it\'s','as','from','up','about','into','through','during','before','after','above','below',
        'between','among','so','if','then','than','too','very','just','because','what','which','who','whom','when','where','why','how'
    }
    
    words = re.findall(r'\b[a-z]{3,}\b', text.lower())
    filtered = [w for w in words if w not in stopwords]
    if not filtered:
        filtered = words
    freq = Counter(filtered)
    
    # Score sentences
    scored = []
    for idx, sent in enumerate(sentences):
        sent_words = re.findall(r'\b[a-z]{3,}\b', sent.lower())
        score = sum(freq.get(w, 0) for w in sent_words)
        # Slight bonus for early sentences, penalty for very long sentences
        position_bonus = max(0, 5 - idx) * 0.5
        length_penalty = 0 if 10 < len(sent_words) < 35 else -2
        scored.append((score + position_bonus + length_penalty, idx, sent))
    
    scored.sort(reverse=True, key=lambda x: x[0])
    
    # Pick top 5-7 sentences for main content
    top_n = min(6, len(sentences))
    top_sentences = sorted(scored[:top_n], key=lambda x: x[1])  # back to original order
    key_points = [s for _, _, s in top_sentences]
    
    # Fallback if scoring failed
    if not key_points:
        key_points = sentences[:5]

    # Pick analogy based on content keywords
    text_lower = text.lower()
    if any(k in text_lower for k in ['network', 'system', 'server', 'data', 'computer', 'software']):
        analogy = "Think of it like a city’s road network — each part has a role, and when they sync up, everything flows. When one road jams, you feel it everywhere."
    elif any(k in text_lower for k in ['money', 'finance', 'market', 'investment', 'economy', 'business', 'revenue']):
        analogy = "Think of it like running a small lemonade stand — you track costs, revenue, and what customers really want. Scale that up, and you get the big picture."
    elif any(k in text_lower for k in ['health', 'medical', 'disease', 'treatment', 'patient', 'cell', 'biology']):
        analogy = "Think of it like a team of mechanics for your body — each specialist checks a different system, but they all work together to keep the engine running."
    elif any(k in text_lower for k in ['education', 'learning', 'student', 'teacher', 'school']):
        analogy = "Think of it like learning to ride a bike — you start wobbly, get guidance, practice, and eventually it clicks and you don’t forget."
    else:
        analogy = "Think of it like assembling furniture — it looks complex until you see how the pieces connect. Once you get the main idea, the rest falls into place."

    # Build podcast script
    intro = key_points[0] if key_points else text[:200]
    # Ensure intro is not too long
    if len(intro) > 300:
        intro = intro[:287] + "..."

    middle = " ".join(key_points[1:4]) if len(key_points) > 1 else " ".join(key_points)
    recap = " ".join(key_points[-2:]) if len(key_points) > 2 else key_points[-1]

    script = f"""🎙️ Welcome back to DocuCast — where we turn dense documents into quick, human-friendly stories.

**Hook / Intro**
Ever wondered what this document is *really* saying? Here’s the one-minute version: {intro}

**Main Explanation**
{ ' '.join(key_points[:4]) }

Here’s an analogy to make it stick: {analogy}

Zooming out a bit — {middle}

**Quick Recap**
So, to wrap it up: {recap}

That’s the core of what’s inside the document — no fluff, just what matters. Thanks for listening to DocuCast!
"""
    # Keep under ~400 words
    words_out = script.split()
    if len(words_out) > 380:
        script = " ".join(words_out[:380]) + "..."
    
    return script.strip()


# ---------------------------------------------------------------------------
# Provider implementations - each is isolated and import-safe
# ---------------------------------------------------------------------------

def _try_gemini(text: str, api_key: str) -> str:
    """Try Gemini. Raises on failure so caller can fallback."""
    if not api_key:
        raise ValueError("GEMINI_API_KEY not set")
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:
        raise ValueError(f"google-genai not installed: {e}")

    # Support multiple model names - 3.6-flash doesn't exist yet, fallback to real models
    models_to_try = [
        os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-1.5-flash-8b",
    ]
    # Deduplicate
    seen = set()
    models_to_try = [m for m in models_to_try if not (m in seen or seen.add(m))]

    client = genai.Client(api_key=api_key)
    prompt = _build_user_prompt(text)
    
    last_err = None
    for model in models_to_try:
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_INSTRUCTION,
                    temperature=0.7,
                    max_output_tokens=800,
                ),
            )
            script = (getattr(response, "text", "") or "").strip()
            if script:
                return script
            # Empty response - try next model
            last_err = ValueError(f"Gemini {model} returned empty response")
        except Exception as exc:
            msg = str(exc).lower()
            # If quota/rate limit, bubble up immediately to fallback chain
            if any(k in msg for k in ["quota", "429", "resource_exhausted", "limit", "exceeded"]):
                raise ValueError(f"Gemini quota/limit hit ({model}): {exc}")
            if "404" in msg or "not found" in msg:
                last_err = exc
                continue  # try next model id
            raise ValueError(f"Gemini {model} failed: {exc}") from exc
    
    raise ValueError(f"Gemini failed on all models: {last_err}")


def _try_groq(text: str, api_key: str) -> str:
    """Groq - free, 14k req/day, fastest. https://console.groq.com/keys"""
    if not api_key:
        raise ValueError("GROQ_API_KEY not set")
    import requests
    models_to_try = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768", "gemma2-9b-it"]
    prompt = _build_user_prompt(text)
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    
    last_err = None
    for model in models_to_try:
        try:
            resp = requests.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers=headers,
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_INSTRUCTION},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.7,
                    "max_tokens": 800,
                },
                timeout=30,
            )
            if resp.status_code == 429:
                raise ValueError(f"Groq rate limit: {resp.text}")
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()
            if content:
                return content
            last_err = ValueError("Empty response")
        except Exception as exc:
            last_err = exc
            if "429" in str(exc) or "rate" in str(exc).lower():
                raise
            continue
    raise ValueError(f"Groq failed: {last_err}")


def _try_openrouter(text: str, api_key: str) -> str:
    """OpenRouter - many FREE models, no credit card. https://openrouter.ai/keys"""
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY not set")
    import requests
    # All these have :free variants
    models_to_try = [
        "meta-llama/llama-3.3-70b-instruct:free",
        "qwen/qwen-2.5-7b-instruct:free",
        "google/gemma-2-9b-it:free",
        "mistralai/mistral-7b-instruct:free",
        "huggingfaceh4/zephyr-7b-beta:free",
    ]
    prompt = _build_user_prompt(text)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://docucast.local",
        "X-Title": "DocuCast",
    }
    last_err = None
    for model in models_to_try:
        try:
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers=headers,
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_INSTRUCTION},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.7,
                    "max_tokens": 800,
                },
                timeout=30,
            )
            if resp.status_code == 429:
                raise ValueError(f"OpenRouter rate limit: {resp.text}")
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()
            if content:
                return content
        except Exception as exc:
            last_err = exc
            continue
    raise ValueError(f"OpenRouter failed: {last_err}")


def _try_cerebras(text: str, api_key: str) -> str:
    """Cerebras - free tier ultra fast. https://cloud.cerebras.ai/"""
    if not api_key:
        raise ValueError("CEREBRAS_API_KEY not set")
    import requests
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    resp = requests.post(
        "https://api.cerebras.ai/v1/chat/completions",
        headers=headers,
        json={
            "model": "llama3.1-8b",
            "messages": [
                {"role": "system", "content": SYSTEM_INSTRUCTION},
                {"role": "user", "content": _build_user_prompt(text)},
            ],
            "temperature": 0.7,
            "max_tokens": 800,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


def _try_huggingface(text: str, token: str) -> str:
    """Hugging Face Inference - free. https://huggingface.co/settings/tokens"""
    if not token:
        raise ValueError("HF_TOKEN not set")
    import requests
    # Use Inference API - try a few free models
    models_to_try = [
        "mistralai/Mistral-7B-Instruct-v0.2",
        "HuggingFaceH4/zephyr-7b-beta",
        "google/gemma-2-9b-it",
    ]
    prompt = f"{SYSTEM_INSTRUCTION}\n\nDocument:\n{text}\n\nPodcast script:"
    headers = {"Authorization": f"Bearer {token}"}
    last_err = None
    for model in models_to_try:
        try:
            resp = requests.post(
                f"https://api-inference.huggingface.co/models/{model}",
                headers=headers,
                json={
                    "inputs": prompt,
                    "parameters": {"max_new_tokens": 800, "temperature": 0.7, "return_full_text": False},
                },
                timeout=45,
            )
            if resp.status_code == 429:
                # HF often returns 503 loading, wait or try next
                continue
            resp.raise_for_status()
            data = resp.json()
            if isinstance(data, list) and data:
                out = data[0].get("generated_text", "").strip()
                if out:
                    return out
            elif isinstance(data, dict) and "generated_text" in data:
                out = data["generated_text"].strip()
                if out:
                    return out
        except Exception as exc:
            last_err = exc
            continue
    raise ValueError(f"HuggingFace failed: {last_err}")


def _try_ollama(text: str, host: str = None) -> str:
    """Ollama - 100% free, unlimited, offline. https://ollama.com
    Run: ollama pull llama3.2  &&  ollama serve
    """
    import requests
    host = (host or os.getenv("OLLAMA_HOST", "http://localhost:11434")).rstrip("/")
    models_to_try = ["llama3.2", "llama3.1", "mistral", "phi3", "gemma2", "qwen2.5"]
    
    # First check if Ollama is running and what models are available
    try:
        tags_resp = requests.get(f"{host}/api/tags", timeout=5)
        if tags_resp.ok:
            available = [m["name"].split(":")[0] for m in tags_resp.json().get("models", [])]
            # Prefer available models first
            if available:
                models_to_try = [m for m in models_to_try if any(m in a for a in available)] + models_to_try
    except:
        pass  # Ollama might not be running

    prompt = f"{SYSTEM_INSTRUCTION}\n\n{_build_user_prompt(text)}"
    last_err = None
    for model in models_to_try:
        try:
            resp = requests.post(
                f"{host}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.7, "num_predict": 800},
                },
                timeout=60,
            )
            if resp.status_code == 404 and "not found" in resp.text.lower():
                continue  # try next model
            resp.raise_for_status()
            data = resp.json()
            out = data.get("response", "").strip()
            if out:
                return out
        except Exception as exc:
            last_err = exc
            continue
    raise ValueError(f"Ollama failed (is it running? `ollama serve`): {last_err}")


# ---------------------------------------------------------------------------
# Main entry points
# ---------------------------------------------------------------------------

# Map provider name -> callable
_PROVIDER_FUNCS = {
    "gemini": lambda text: _try_gemini(text, os.getenv("GEMINI_API_KEY", "")),
    "groq": lambda text: _try_groq(text, os.getenv("GROQ_API_KEY", "")),
    "openrouter": lambda text: _try_openrouter(text, os.getenv("OPENROUTER_API_KEY", "")),
    "cerebras": lambda text: _try_cerebras(text, os.getenv("CEREBRAS_API_KEY", "")),
    "huggingface": lambda text: _try_huggingface(text, os.getenv("HF_TOKEN", "") or os.getenv("HUGGINGFACE_API_KEY", "")),
    "ollama": lambda text: _try_ollama(text, os.getenv("OLLAMA_HOST", "")),
    "local": lambda text: _local_fallback_podcast(text),
}

# Recommended order for auto - cheap/fast/free first after gemini
_AUTO_ORDER = ["gemini", "groq", "openrouter", "cerebras", "huggingface", "ollama", "local"]

def _get_provider_order() -> list:
    pref = os.getenv("LLM_PROVIDER", "local").strip().lower()
    if pref == "auto" or pref == "":
        return _AUTO_ORDER
    if pref in _PROVIDER_FUNCS:
        # Put preferred first, then rest (ending with local always)
        order = [pref] + [p for p in _AUTO_ORDER if p != pref]
        return order
    # Support comma-separated list like "groq,ollama,local"
    if "," in pref:
        parts = [p.strip() for p in pref.split(",") if p.strip() in _PROVIDER_FUNCS]
        if parts:
            # Append remaining not mentioned, ensure local last
            remaining = [p for p in _AUTO_ORDER if p not in parts]
            return parts + remaining
    return _AUTO_ORDER


def generate_script_with_provider(text: str, api_key: str = None) -> tuple[str, str]:
    """Generate script, returning (script, provider_used).

    Tries providers in order until one succeeds. Local fallback always succeeds.
    api_key param is kept for backward compat - if provided, sets GEMINI_API_KEY for this call.
    """
    if api_key:
        # Backward compat: if caller passes api_key, treat as Gemini key if none set
        if not os.getenv("GEMINI_API_KEY"):
            os.environ["GEMINI_API_KEY"] = api_key

    order = _get_provider_order()
    errors = {}

    for provider in order:
        func = _PROVIDER_FUNCS[provider]
        try:
            # Skip providers with no key except ollama/local which can probed
            if provider == "gemini" and not os.getenv("GEMINI_API_KEY"):
                continue
            if provider == "groq" and not os.getenv("GROQ_API_KEY"):
                continue
            if provider == "openrouter" and not os.getenv("OPENROUTER_API_KEY"):
                continue
            if provider == "cerebras" and not os.getenv("CEREBRAS_API_KEY"):
                continue
            if provider == "huggingface" and not (os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_API_KEY")):
                continue
            # ollama and local always tried (ollama will fail quickly if not running)

            script = func(text)
            if script and script.strip():
                return script.strip(), provider
        except Exception as exc:
            errors[provider] = str(exc)
            # For quota/rate limit, continue to next provider immediately
            continue

    # Local should never fail - but as absolute safety, call it directly
    try:
        return _local_fallback_podcast(text), "local"
    except Exception as exc:
        raise ValueError(f"All providers failed. Errors: {errors}. Local fallback also failed: {exc}") from exc


def generate_script(text: str, api_key: str = None) -> str:
    """Backward compatible: returns just script string.
    
    Now with automatic fallback chain. Will NEVER fail due to quota if local fallback is available.
    """
    script, provider = generate_script_with_provider(text, api_key)
    return script


def get_available_providers() -> dict:
    """Return dict of provider -> availability info for health checks."""
    info = {}
    for name in _PROVIDER_FUNCS:
        if name == "gemini":
            info[name] = bool(os.getenv("GEMINI_API_KEY"))
        elif name == "groq":
            info[name] = bool(os.getenv("GROQ_API_KEY"))
        elif name == "openrouter":
            info[name] = bool(os.getenv("OPENROUTER_API_KEY"))
        elif name == "cerebras":
            info[name] = bool(os.getenv("CEREBRAS_API_KEY"))
        elif name == "huggingface":
            info[name] = bool(os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_API_KEY"))
        elif name == "ollama":
            # probe
            try:
                import requests
                host = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
                r = requests.get(f"{host}/api/tags", timeout=2)
                info[name] = r.ok
            except:
                info[name] = False
        elif name == "local":
            info[name] = True  # always
    return info
