# DocuCast — PDF → Podcast

> **AI limits finished?** DocuCast now has **free unlimited alternatives** — no breakage, auto-fallback. See below.

DocuCast MVP turns PDFs into podcast-style audio with AI analogies. Stack: **React + Vite + Tailwind + FastAPI + Edge-TTS**. Now works even when Gemini hits 429/quota.

### 🚨 My AI limits are finished — alternative?

**You don't need to change code.** Backend now auto-falls back:

```
Gemini → Groq (free) → OpenRouter (free) → Cerebras → HuggingFace → Ollama (offline) → Local (always)
```

Pick one:

**1. Fastest fix (30 sec) — Groq FREE 14k req/day:**
```bash
# 1. Get key at https://console.groq.com/keys (no CC)
# 2. In docucast-mvp/backend/.env add:
GROQ_API_KEY=gsk_xxx...
LLM_PROVIDER=auto
# 3. Restart: uvicorn main:app --reload
```
Done. Keep `GEMINI_API_KEY` + `GROQ_API_KEY` together → auto fallback when Gemini quota hits.

**2. Unlimited offline, no key ever:**
```bash
# In backend/.env:
LLM_PROVIDER=local
# or for better quality local LLM:
# install https://ollama.com → ollama pull llama3.2 → ollama serve
OLLAMA_HOST=http://localhost:11434
LLM_PROVIDER=ollama
```

**3. Other free:** `OPENROUTER_API_KEY` (openrouter.ai/keys) or `HF_TOKEN` (huggingface.co/settings/tokens).

Check `GET /providers` to see what's ready. Frontend also shows a banner with alternatives.

### Project

- `docucast-mvp/` — full MVP (see its README for details)
- `docucast-mvp/backend` — FastAPI + multi-provider LLM
- `docucast-mvp/frontend` — React

### Quick Start

```bash
cd docucast-mvp/backend
pip install -r requirements.txt
cp .env.example .env  # set GEMINI_API_KEY or GROQ_API_KEY or LLM_PROVIDER=local
uvicorn main:app --reload

cd ../frontend
npm install
npm run dev
```

See `docucast-mvp/README.md` for full docs + deployment.

### Why this works forever

- `local` provider uses TF extractive summarization — pure Python, zero API, unlimited.
- Ollama runs locally — 100% private, unlimited, offline.
- Groq/OpenRouter free tiers are generous and auto-retried.
