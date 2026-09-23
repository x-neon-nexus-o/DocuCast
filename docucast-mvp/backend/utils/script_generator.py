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

import json
import os
import re
from collections import Counter

# ---------------------------------------------------------------------------
# Steerable podcast options (this is where we out-do NotebookLM: their audio
# overviews are one-size-fits-all; DocuCast lets listeners pick the show)
# ---------------------------------------------------------------------------
LENGTH_PRESETS = {
    "brief": ("about 250 words (a tight ~2 minute episode)", 250),
    "standard": ("about 450 words (a ~4 minute episode)", 450),
    "deep": ("about 800 words (an in-depth ~7 minute episode)", 800),
}

TONE_PRESETS = {
    "conversational": "warm, conversational and engaging — like two friends who genuinely find this fascinating",
    "energetic": "high-energy, punchy and enthusiastic — quick exchanges, excitement about the ideas",
    "calm": "calm, thoughtful and measured — an unhurried late-night radio feel",
    "expert": "precise and analytical, but still human — a sharp expert briefing",
}

AUDIENCE_PRESETS = {
    "general": "curious general listeners with no background — use simple 8th-grade language",
    "student": "students studying this topic — define terms, reinforce the concepts they'd be tested on",
    "expert": "domain experts — skip the basics, focus on methods, numbers, limitations and implications",
    "executive": "busy executives — lead with the bottom line, decisions and business impact",
}

DEFAULT_OPTIONS = {
    "mode": "dialogue",       # dialogue | solo
    "length": "standard",     # brief | standard | deep
    "tone": "conversational",
    "audience": "general",
    "focus": "",              # optional listener steering, e.g. "focus on the results section"
    "language": "en",
    "host_a_name": "NOVA",
    "host_b_name": "RHYS",
}

HOST_A = "NOVA"
HOST_B = "RHYS"


def build_system_instruction(options: dict | None = None) -> str:
    opts = {**DEFAULT_OPTIONS, **(options or {})}
    host_a = str(opts.get("host_a_name") or HOST_A).strip()[:24] or HOST_A
    host_b = str(opts.get("host_b_name") or HOST_B).strip()[:24] or HOST_B
    length_desc, _ = LENGTH_PRESETS.get(opts["length"], LENGTH_PRESETS["standard"])
    tone = TONE_PRESETS.get(opts["tone"], TONE_PRESETS["conversational"])
    audience = AUDIENCE_PRESETS.get(opts["audience"], AUDIENCE_PRESETS["general"])
    language = str(opts.get("language") or "en").strip()

    common_rules = f"""
Rules for Professional Podcasting:
- EXPLAIN ONLY what exists in the document brief. Do NOT invent external facts, but DO interpret the facts naturally.
- Weave in TABLES, GRAPHS, IMAGES, and NOTES smoothly. Never read a table cell-by-cell; tell the story the data tells (e.g., "There's a chart here that spikes massively when...").
- Use 1-2 brilliant, highly relatable analogies to explain complex ideas.
- Use natural, spoken-word phrasing. Short sentences. Punchy verbs. Avoid academic jargon unless you immediately explain it in plain English.
- Target length: {length_desc}.
- Tone: {tone}.
- Audience: {audience}.
- Write the entire spoken script in language code: {language}. Keep the speaker names exactly as labels, but translate every spoken sentence.
- Output PLAIN spoken text only: NO markdown, NO asterisks, NO emoji, NO stage directions in brackets. Just the words to be spoken.
"""
    if opts.get("focus"):
        common_rules += f"- Listener steering request (honor it if the document supports it): {opts['focus'][:300]}\n"

    if opts["mode"] == "solo":
        return (
            "You are a master solo podcast host (think 99% Invisible or NPR) turning a document into an engaging audio episode.\n"
            + common_rules
            + "- Structure: Start with a cold open hook that grabs attention immediately. Then the main explanation, and finally a crisp recap.\n"
            "- Write as one narrator. Do not prefix lines with a name."
        )

    return (
        f"You are a master scriptwriter writing a premium two-host podcast conversation between {host_a} and {host_b}.\n"
        f"- {host_a} is the curious guide: asks sharp questions, reacts naturally, and guides the flow.\n"
        f"- {host_b} is the expert explainer: grounded in the document, breaks down complex ideas, and loves a good analogy.\n"
        + common_rules
        + f"""- Format STRICTLY as alternating lines, each starting with the speaker name and a colon:
{host_a}: ...
{host_b}: ...
- Make it sound intensely human: use natural agreements ("Right", "Exactly", "Wow"), brief reactions, and seamless hand-offs.
- Avoid robotic or cheesy transitions. Let the conversation flow organically.
- {host_a} opens with a compelling hook, {host_b} closes with a crisp, memorable takeaway.
- Keep individual turns short and punchy (1-3 sentences max)."""
    )


# The user prompt template
def _build_user_prompt(text: str) -> str:
    return f"Document brief:\n{text}\n\nGenerate the podcast script now."


# ---------------------------------------------------------------------------
# Show notes + chapters (podcast-ready metadata generated from the script)
# ---------------------------------------------------------------------------
SHOW_NOTES_SYSTEM = """You are a podcast producer writing show notes for an episode.
Given the podcast script, reply ONLY with compact JSON (no markdown fences) shaped as:
{"title": "a punchy episode title under 60 chars",
 "description": "a one-sentence episode description",
 "takeaways": ["3-5 key takeaways, each one short sentence"],
 "chapters": [{"title": "chapter title", "summary": "one-line summary"}]}
Rules:
- Derive everything strictly from the script; never invent facts.
- 3-6 chapters, ordered to follow the episode's arc.
- Titles are spoken-word friendly (no jargon without plain meaning)."""


def _parse_show_notes(raw: str) -> dict | None:
    """Extract the JSON object from an LLM reply; tolerate fences/prose."""
    if not raw:
        return None
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except Exception:
        return None
    takeaways = data.get("takeaways")
    chapters = data.get("chapters")
    return {
        "title": (data.get("title") or "")[:120] or None,
        "description": (data.get("description") or "")[:300] or None,
        "takeaways": [str(t)[:240] for t in takeaways[:6]] if isinstance(takeaways, list) else [],
        "chapters": [
            {
                "title": str(c.get("title", ""))[:120],
                "summary": str(c.get("summary", ""))[:240],
            }
            for c in (chapters or [])[:8]
            if isinstance(c, dict) and c.get("title")
        ],
    }


def generate_show_notes(script: str, options: dict | None = None) -> dict | None:
    """Best-effort show notes via the same provider fallback chain.

    Returns {"title","description","takeaways","chapters"} or None (never raises —
    show notes are a bonus, not a blocker).
    """
    if not script or not script.strip():
        return None
    order = _get_provider_order()
    # Notes are cheap — use a small budget and skip ollama/local (local is a
    # template summarizer that can't produce this JSON).
    for provider in order:
        if provider in ("local", "ollama"):
            continue
        try:
            if provider == "gemini" and not (os.getenv("GEMINI_API_KEY") or _EXPLICIT_GEMINI_KEY):
                continue
            if provider == "groq" and not os.getenv("GROQ_API_KEY"):
                continue
            if provider == "openrouter" and not os.getenv("OPENROUTER_API_KEY"):
                continue
            if provider == "cerebras" and not os.getenv("CEREBRAS_API_KEY"):
                continue
            if provider == "huggingface" and not (os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_API_KEY")):
                continue
            raw = _dispatch_provider(
                provider, script[:12000], SHOW_NOTES_SYSTEM, 700, options or {}
            )
            notes = _parse_show_notes(raw)
            if notes and (notes.get("title") or notes.get("takeaways") or notes.get("chapters")):
                return notes
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Chat with the document (grounded Q&A over the enriched source brief)
# ---------------------------------------------------------------------------
CHAT_SYSTEM = """You are DocuCast's document assistant. You answer questions strictly
from the document brief provided. Rules:
- Ground every claim in the brief; if it isn't there, say plainly what the brief
  does and doesn't cover instead of guessing.
- Cite what you use: when an answer relies on a table, chart, figure or
  handwritten note from the brief, mention it naturally (e.g. "per the table on
  page 3", "the chart the hosts discussed").
- Be concise: 2-5 short sentences, spoken-friendly language.
- Answer in plain text, no markdown formatting."""


def answer_question(source_text: str, question: str, history: list | None = None) -> str:
    """Answer one question grounded in the enriched source text.

    Uses the provider fallback chain (local template summarizer is skipped —
    it can't do grounded Q&A). Raises ValueError when no provider can answer.
    """
    if not source_text or not source_text.strip():
        raise ValueError("This episode has no stored source text.")
    if not question or not question.strip():
        raise ValueError("Ask a question first.")

    # Keep the brief bounded but generous; chat answers stay short.
    brief = source_text[:18000]

    conversation = ""
    # A little prior Q&A gives follow-up questions their context.
    for turn in (history or [])[-6:]:
        role = "User" if turn.get("role") == "user" else "You"
        content = (turn.get("content") or "")[:1200]
        if content:
            conversation += f"{role}: {content}\n"
    if conversation:
        conversation += "\n"

    prompt = (
        f"{conversation}"
        f"Document brief:\n{brief}\n\n"
        f"User question: {question.strip()}\n"
        f"Answer now, grounded strictly in the brief."
    )

    order = _get_provider_order()
    errors = {}
    for provider in order:
        if provider in ("local", "ollama"):
            continue  # template summarizer can't answer grounded questions
        if provider == "gemini" and not (os.getenv("GEMINI_API_KEY") or _EXPLICIT_GEMINI_KEY):
            continue
        if provider == "groq" and not os.getenv("GROQ_API_KEY"):
            continue
        if provider == "openrouter" and not os.getenv("OPENROUTER_API_KEY"):
            continue
        if provider == "cerebras" and not os.getenv("CEREBRAS_API_KEY"):
            continue
        if provider == "huggingface" and not (os.getenv("HF_TOKEN") or os.getenv("HUGGINGFACE_API_KEY")):
            continue
        try:
            answer = _dispatch_provider(provider, prompt, CHAT_SYSTEM, 500, {})
            if answer and answer.strip():
                return answer.strip()
        except Exception as exc:
            errors[provider] = str(exc)
            continue
    raise ValueError(
        "No AI provider could answer (all offline/limited right now). "
        f"Provider errors: {errors or 'no keys configured'}"
    )


# Map length preset -> max_output_tokens so deep dives aren't truncated.
_TOKEN_BUDGET = {
    "brief": 600,
    "standard": 1200,
    "deep": 2000,
}


# ---------------------------------------------------------------------------
# Local fallback - TF based extractive summarizer + podcast template
# Works with ZERO API, unlimited, offline
# ---------------------------------------------------------------------------
def _local_fallback_podcast(text: str, options: dict | None = None) -> str:
    """Generate a podcast script without any LLM - pure Python.

    Uses word-frequency scoring to pick key sentences, then wraps them in a
    podcast template (solo or two-host dialogue). Quality is lower than an
    LLM but guarantees the app never fails due to API limits.
    """
    opts = {**DEFAULT_OPTIONS, **(options or {})}
    # Clean and split into sentences
    text = text.strip()
    if not text:
        return "Hey there! It looks like we couldn't find much to talk about in this document. Try uploading a file with more readable content."

    # Strip structural markers from the enriched brief so they aren't narrated
    text = re.sub(r"===[^=\n]+===", " ", text)
    text = re.sub(r"\[(Slide \d+[^\]]*|Code block[^\]]*|[^\]]*truncated[^\]]*|First \d+ pages[^\]]*)\]", " ", text, flags=re.I)
    
    # Strip out all injected table/image/chart structural text
    text = re.sub(r"Table on page \d+ with columns \[.*?\] and \d+ rows\.", " ", text, flags=re.I)
    text = re.sub(r"Key rows:.*?(?=\n\n|\Z)", " ", text, flags=re.I | re.DOTALL)
    text = re.sub(r"\[Chart on slide \d+\]", " ", text, flags=re.I)
    text = re.sub(r"\[Image on page \d+\]", " ", text, flags=re.I)
    
    # Split on sentence boundaries
    sentences = re.split(r'(?<=[.!?])\s+', text)
    
    # Keep only clean sentences (avoid ones with too much weird punctuation or formatting)
    clean_sentences = []
    for s in sentences:
        s = s.strip()
        if len(s) <= 20: continue
        # If it has weird column/row markers or too many colons, it's probably data, skip it
        if "column " in s.lower() or "row —" in s.lower() or s.count(":") > 2 or s.count(";") > 2 or s.count("—") > 2:
            continue
        # Remove extra whitespace
        s = re.sub(r'\s+', ' ', s)
        clean_sentences.append(s)
        
    sentences = clean_sentences
    
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
    main = " ".join(key_points[:4])

    if opts.get("mode") == "solo":
        script = f"""Welcome back to DocuCast, where dense documents become quick, human-friendly stories.

Ever wondered what this document is really saying? Here's the short version: {intro}

{main}

Here's an analogy to make it stick: {analogy}

Zooming out a bit — {middle}

So, to wrap it up: {recap}

That's the core of what's inside — no fluff, just what matters. Thanks for listening to DocuCast!"""
    else:
        mid_points = key_points[1:4] or key_points[:1]
        qa_lines = []
        questions = [
            "Okay, so what's the big idea here?",
            "Interesting. What else stood out to you?",
            "And how should we make sense of all that?",
        ]
        for i, point in enumerate(mid_points[:3]):
            qa_lines.append(f"{HOST_A}: {questions[min(i, len(questions) - 1)]}")
            qa_lines.append(f"{HOST_B}: {point}")
        qa_block = "\n".join(qa_lines)
        script = f"""{HOST_A}: Welcome back to DocuCast! Today we're unpacking a document, and honestly, there's more in here than you'd expect.
{HOST_B}: There really is. Here's the headline: {intro}
{qa_block}
{HOST_A}: I like that. Give me something to make it stick.
{HOST_B}: {analogy}
{HOST_A}: Perfect. So, bottom line?
{HOST_B}: {recap} That's the core of it — no fluff, just what matters.
{HOST_A}: Love it. Thanks for listening to DocuCast!"""

    # Respect the requested length budget
    _, word_budget = LENGTH_PRESETS.get(opts.get("length", "standard"), LENGTH_PRESETS["standard"])
    words_out = script.split()
    if len(words_out) > word_budget + 80:
        script = " ".join(words_out[: word_budget + 80]) + "..."

    return script.strip()


# ---------------------------------------------------------------------------
# Provider implementations - each is isolated and import-safe
# ---------------------------------------------------------------------------

def _try_gemini(text: str, api_key: str, system_instruction: str = "", max_tokens: int = 1200) -> str:
    """Try Gemini. Raises on failure so caller can fallback."""
    if not api_key:
        raise ValueError("GEMINI_API_KEY not set")
    try:
        from google import genai
        from google.genai import types
    except ImportError as e:
        raise ValueError(f"google-genai not installed: {e}")

    models_to_try = [
        os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
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
                    system_instruction=system_instruction,
                    temperature=0.7,
                    max_output_tokens=max_tokens,
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


def _try_groq(text: str, api_key: str, system_instruction: str = "", max_tokens: int = 1200) -> str:
    """Groq - free, 14k req/day, fastest. https://console.groq.com/keys"""
    if not api_key:
        raise ValueError("GROQ_API_KEY not set")
    import requests
    models_to_try = [
        os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
        "llama-3.1-8b-instant",
        "gemma2-9b-it",
        "openai/gpt-oss-120b",
    ]
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
                        {"role": "system", "content": system_instruction},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.7,
                    "max_tokens": max_tokens,
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


def _try_openrouter(text: str, api_key: str, system_instruction: str = "", max_tokens: int = 1200) -> str:
    """OpenRouter - many FREE models, no credit card. https://openrouter.ai/keys"""
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY not set")
    import requests
    # Prioritize the most capable free models first, then fallback to premium if credits exist
    models_to_try = [
        "meta-llama/llama-3.3-70b-instruct:free",
        "nvidia/llama-3.1-nemotron-70b-instruct:free",
        "google/gemini-2.0-flash-exp:free",
        "qwen/qwen-2.5-7b-instruct:free",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
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
                        {"role": "system", "content": system_instruction},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.7,
                    "max_tokens": max_tokens,
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


def _try_cerebras(text: str, api_key: str, system_instruction: str = "", max_tokens: int = 1200) -> str:
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
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": _build_user_prompt(text)},
            ],
            "temperature": 0.7,
            "max_tokens": max_tokens,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"].strip()


def _try_huggingface(text: str, token: str, system_instruction: str = "", max_tokens: int = 1200) -> str:
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
    prompt = f"{system_instruction}\n\nDocument:\n{text}\n\nPodcast script:"
    headers = {"Authorization": f"Bearer {token}"}
    last_err = None
    for model in models_to_try:
        try:
            resp = requests.post(
                f"https://api-inference.huggingface.co/models/{model}",
                headers=headers,
                json={
                    "inputs": prompt,
                    "parameters": {"max_new_tokens": max_tokens, "temperature": 0.7, "return_full_text": False},
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


def _try_ollama(text: str, host: str = None, system_instruction: str = "", max_tokens: int = 1200) -> str:
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

    prompt = f"{system_instruction}\n\n{_build_user_prompt(text)}"
    last_err = None
    for model in models_to_try:
        try:
            resp = requests.post(
                f"{host}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.7, "num_predict": max_tokens},
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

# Provider name -> list of valid names (for key checks in the dispatch loop).
_PROVIDER_NAMES = ["gemini", "groq", "openrouter", "cerebras", "huggingface", "ollama", "local"]

# Per-call Gemini key (backward-compat `api_key` argument) — used without
# mutating the process-wide environment.
_EXPLICIT_GEMINI_KEY: str | None = None

# Recommended order for auto - cheap/fast/free first after gemini
_AUTO_ORDER = ["gemini", "groq", "openrouter", "cerebras", "huggingface", "ollama", "local"]


def _get_provider_order() -> list:
    pref = os.getenv("LLM_PROVIDER", "auto").strip().lower()
    if pref == "auto" or pref == "":
        return list(_AUTO_ORDER)
    if pref in _PROVIDER_NAMES:
        # Put preferred first, then rest (ending with local always)
        order = [pref] + [p for p in _AUTO_ORDER if p != pref]
        return order
    # Support comma-separated list like "groq,ollama,local"
    if "," in pref:
        parts = [p.strip() for p in pref.split(",") if p.strip() in _PROVIDER_NAMES]
        if parts:
            # Append remaining not mentioned, ensure local last
            remaining = [p for p in _AUTO_ORDER if p not in parts]
            return parts + remaining
    return list(_AUTO_ORDER)


def _dispatch_provider(provider: str, text: str, system_instruction: str, max_tokens: int, options: dict) -> str:
    """Call the right provider function with per-request params (no shared globals)."""
    if provider == "gemini":
        return _try_gemini(
            text,
            os.getenv("GEMINI_API_KEY", "") or _EXPLICIT_GEMINI_KEY or "",
            system_instruction,
            max_tokens,
        )
    if provider == "groq":
        return _try_groq(text, os.getenv("GROQ_API_KEY", ""), system_instruction, max_tokens)
    if provider == "openrouter":
        return _try_openrouter(text, os.getenv("OPENROUTER_API_KEY", ""), system_instruction, max_tokens)
    if provider == "cerebras":
        return _try_cerebras(text, os.getenv("CEREBRAS_API_KEY", ""), system_instruction, max_tokens)
    if provider == "huggingface":
        return _try_huggingface(text, os.getenv("HF_TOKEN", "") or os.getenv("HUGGINGFACE_API_KEY", ""), system_instruction, max_tokens)
    if provider == "ollama":
        return _try_ollama(text, os.getenv("OLLAMA_HOST", ""), system_instruction, max_tokens)
    if provider == "local":
        return _local_fallback_podcast(text, options)
    raise ValueError(f"Unknown provider: {provider}")


def generate_script_with_provider(text: str, api_key: str = None, options: dict | None = None) -> tuple[str, str]:
    """Generate script, returning (script, provider_used).

    Tries providers in order until one succeeds. Local fallback always succeeds.
    `options` steers the episode: mode (dialogue|solo), length (brief|standard|deep),
    tone, audience, focus.
    api_key param is kept for backward compat - if provided, it is used as the
    Gemini key for this call (without touching the process environment).
    """
    global _EXPLICIT_GEMINI_KEY
    current_options = {**DEFAULT_OPTIONS, **(options or {})}
    system_instruction = build_system_instruction(current_options)
    max_tokens = _TOKEN_BUDGET.get(current_options.get("length", "standard"), 1200)

    _EXPLICIT_GEMINI_KEY = api_key

    order = _get_provider_order()
    errors = {}

    for provider in order:
        try:
            # Skip providers with no key except ollama/local which can be probed
            if provider == "gemini" and not (os.getenv("GEMINI_API_KEY") or _EXPLICIT_GEMINI_KEY):
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

            script = _dispatch_provider(provider, text, system_instruction, max_tokens, current_options)
            if script and script.strip():
                return script.strip(), provider
        except Exception as exc:
            errors[provider] = str(exc)
            # For quota/rate limit, continue to next provider immediately
            continue

    # Local should never fail - but as absolute safety, call it directly
    try:
        return _local_fallback_podcast(text, current_options), "local"
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
    for name in _PROVIDER_NAMES:
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
