# DocuCast MVP

Turn an uploaded PDF into a short, podcast-style audio explanation using AI-generated analogies.

A lean, zero-cost-stack MVP: **React + Vite + TailwindCSS** frontend, **FastAPI + Gemini + Edge-TTS** backend. Now with **free unlimited AI alternatives** when Gemini limits are hit. No auth, no database, no file persistence.

## Project Structure

```
docucast-mvp/
  frontend/        # React (Vite) + TailwindCSS + Axios
    src/
      App.jsx
      main.jsx
      components/
        UploadSection.jsx
        ResultSection.jsx
  backend/         # FastAPI
    main.py
    utils/
      pdf_parser.py
      script_generator.py   # <-- multi-provider fallback here
      tts_engine.py
    requirements.txt
    .env.example
```

## How It Works

1. User uploads a PDF (max 10 MB).
2. The FastAPI backend:
   - Validates file type and size.
   - Extracts text from the **first 10 pages** with `pypdf`.
   - Cleans whitespace and truncates at **8000 characters on a sentence boundary**.
   - Sends the text to LLM with podcast-host prompt (auto-fallback chain: Gemini → Groq → OpenRouter → Cerebras → Hugging Face → Ollama → Local).
   - Synthesizes the script to MP3 via Edge-TTS (`en-US-JennyNeural`).
   - Returns `{ "script": "...", "audio_base64": "...", "provider": "groq" }` in one JSON response.
3. The frontend renders the script, an HTML5 `<audio>` player, and a download button. Shows which provider was used.

The LLM call and Edge-TTS call are wrapped separately: if TTS fails after a script is generated, the script is still returned with an `audio_error` flag.

---

## 🚀 AI Limits Finished? Free Unlimited Alternatives

> **Gemini free tier = 60 req/min, 1500/day. When you hit 429/quota, DocuCast NEVER breaks — it auto-falls back.**

### Quick Fix (pick ONE, <1 min)

| Alternative | Cost | Setup | Speed | Quality | Best For |
|-------------|------|-------|-------|---------|----------|
| **⭐ Groq** | **FREE 14k req/day** | `GROQ_API_KEY` only | ⚡ Fastest | ★★★★★ | **Recommended** — 30 sec signup |
| **Ollama** | **FREE unlimited offline** | Install + `ollama pull llama3.2` | Fast | ★★★★ | Privacy / unlimited |
| **Local** | **FREE unlimited no key** | `LLM_PROVIDER=local` | Instant | ★★½ | Zero setup, always works |
| **OpenRouter** | FREE :free models | `OPENROUTER_API_KEY` | Fast | ★★★★ | Many model choices |
| Hugging Face | FREE | `HF_TOKEN` | Medium | ★★★ | HF ecosystem |
| Cerebras | FREE | `CEREBRAS_API_KEY` | ⚡ Ultra | ★★★★ | Speed |

### 1. Groq — Recommended (fastest free fix)

1. Go to **https://console.groq.com/keys** → Sign up (no credit card) → Create API Key
2. In `backend/.env` add:
   ```
   GROQ_API_KEY=gsk_your_key_here
   LLM_PROVIDER=auto
   ```
3. Restart backend: `uvicorn main:app --reload`
4. Done. Now `GEMINI + GROQ` both set → if Gemini hits 429, it auto-retries with Groq. Check `GET /providers`.

### 2. Ollama — 100% Unlimited Offline (no limits ever)

Great when you want **zero limits forever**, offline, private.

```bash
# Install from https://ollama.com
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model (pick one)
ollama pull llama3.2        # best balance (2GB)
ollama pull mistral         # alternative
ollama pull phi3            # small/fast (2.2GB)

# Run server
ollama serve
```

In `backend/.env`:
```
OLLAMA_HOST=http://localhost:11434
LLM_PROVIDER=ollama   # or 'auto' to keep Gemini as primary
```

### 3. Local (No API at all)

Instant, works even with **no internet**:

```
LLM_PROVIDER=local
```

Uses TF-based extractive summarization + podcast template. Quality lower but **never fails, never rate-limited**. Perfect for demos/offline.

### 4. OpenRouter (free models)

- Get key: **https://openrouter.ai/keys** (free, many `:free` models)
- `OPENROUTER_API_KEY=sk-or-v1_...`
- Uses `meta-llama/llama-3.3-70b-instruct:free` etc.

### 5. Hugging Face

- Get token: **https://huggingface.co/settings/tokens**
- `HF_TOKEN=hf_...`

### Env Reference

```bash
# Auto mode (default): tries Gemini → Groq → OpenRouter → Cerebras → HF → Ollama → local
LLM_PROVIDER=auto

# Force one provider:
LLM_PROVIDER=groq
LLM_PROVIDER=ollama
LLM_PROVIDER=local

# Or comma-chain:
LLM_PROVIDER=groq,ollama,local
```

Check status at `GET /` or `GET /providers` — shows which providers are ready (green = configured).

---

## Local Run

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # then set GEMINI_API_KEY or GROQ_API_KEY or LLM_PROVIDER=local
uvicorn main:app --reload
```

The API runs at `http://localhost:8000`. Health check: `GET /` shows active providers. `GET /providers` shows setup guide.

### Frontend

```bash
cd frontend
npm install
cp .env.example .env        # defaults to http://localhost:8000
npm run dev
```

Open `http://localhost:5173`.

## Configuration

### Backend `.env`

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Google Gemini key (https://aistudio.google.com/app/apikey). Optional if using alternative. |
| `GROQ_API_KEY` | Groq free key (https://console.groq.com/keys) — **recommended alternative** |
| `OPENROUTER_API_KEY` | OpenRouter key (https://openrouter.ai/keys) |
| `CEREBRAS_API_KEY` | Cerebras key (https://cloud.cerebras.ai/) |
| `HF_TOKEN` | Hugging Face token (https://huggingface.co/settings/tokens) |
| `OLLAMA_HOST` | Ollama URL, default `http://localhost:11434` |
| `LLM_PROVIDER` | `auto` (default), `gemini`, `groq`, `openrouter`, `huggingface`, `ollama`, `local` |
| `GEMINI_MODEL` | Override model id (default tries 3.6-flash → 2.0-flash → 1.5-flash) |
| `VERCEL_ORIGIN` | Deployed Vercel origin (e.g. `https://docucast.vercel.app`). Localhost always allowed. |

### Frontend `.env`

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Public backend URL (Render/Railway in production, `http://localhost:8000` locally). |

## Stack & Model Notes

- **Gemini SDK:** uses the new `google-genai` SDK (`from google import genai`). The
  legacy `google-generativeai` package was deprecated on **August 31, 2025** and emits
  warnings; it will eventually stop working. Do not use it for new code.
- **Model:** tries `gemini-3.6-flash` (if set) then falls back to `gemini-2.0-flash` / `gemini-1.5-flash` automatically if 404. Google retires Flash models every few months — if a call starts returning a 404, check the current model ID in [Google AI Studio](https://aistudio.google.com/) and set `GEMINI_MODEL`.
- **Fallback chain:** `script_generator.py` now tries providers in order until one succeeds; `local` always succeeds, so the app never errors due to quota.
- **TTS:** `edge-tts` is an unofficial wrapper around Microsoft Edge's free Read-Aloud endpoint. It needs no API key but can break if Microsoft changes things — fine for an MVP, not a long-term dependency.
- **PDF:** `pypdf` (the maintained successor to the unmaintained `PyPDF2`) handles text extraction. It cannot read scanned/image-only PDFs; those return a clear error.

## Deployment

### Backend (Render or Railway)

- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Set **one** of these env vars: `GEMINI_API_KEY` or `GROQ_API_KEY` (or `LLM_PROVIDER=local` for no key). For resilience set both `GEMINI_API_KEY` + `GROQ_API_KEY` with `LLM_PROVIDER=auto`.
- Set `VERCEL_ORIGIN` to the Vercel URL so CORS locks down.
- A `Procfile` is included for Render/Railway compatibility.

### Frontend (Vercel)

- Root: `frontend/`
- Framework preset: Vite
- Build: `npm run build`, Output: `dist`
- Set `VITE_API_URL` to the deployed backend URL.
- `vercel.json` is included.

After the first deploy, set the backend's `VERCEL_ORIGIN` to the Vercel URL.

## Limits & Safeguards

- PDF only, max 10 MB (checked before processing).
- First 10 pages processed; longer documents append a notice.
- 8000-character extraction cap, truncated on a sentence boundary.
- Scanned/image-only PDFs (no extractable text) return a clear error.
- Simple in-memory per-IP throttle: 5 requests / 60 seconds.
- Frontend Axios timeout: 90 seconds (cold starts + chained AI/TTS calls can be slow).
- Everything is processed in-memory: no database, no auth, no server-side file storage.

## Known Risks

- **Free-tier cold starts** (Render/Railway) can add 20–50s to the first request.
- **edge-tts** is an unofficial wrapper around Microsoft Edge's TTS endpoint; it may break without notice.
- **Gemini free-tier** requests may be used by Google to improve their products. Do not upload sensitive documents. Local/Ollama alternative is 100% private.
- **Local fallback** quality is lower than LLM — use Groq/Ollama for best free quality.

## Out of Scope (MVP)

Login, database, payments, multi-language support, analytics, cloud storage, user history, server-side file persistence, and real-time progress reporting (SSE/WebSockets).
