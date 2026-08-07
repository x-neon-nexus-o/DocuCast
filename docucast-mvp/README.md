# DocuCast MVP

Turn an uploaded PDF into a short, podcast-style audio explanation using AI-generated analogies.

A lean, zero-cost-stack MVP: **React + Vite + TailwindCSS** frontend, **FastAPI + Gemini + Edge-TTS** backend. No auth, no database, no file persistence.

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
      script_generator.py
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
   - Sends the text to Gemini (`gemini-3.6-flash`) with the podcast-host prompt.
   - Synthesizes the script to MP3 via Edge-TTS (`en-US-JennyNeural`).
   - Returns `{ "script": "...", "audio_base64": "..." }` in one JSON response.
3. The frontend renders the script, an HTML5 `<audio>` player, and a download button.

The Gemini call and Edge-TTS call are wrapped separately: if TTS fails after a script is generated, the script is still returned with an `audio_error` flag.

## Local Run

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # then set GEMINI_API_KEY
uvicorn main:app --reload
```

The API runs at `http://localhost:8000`. Health check: `GET /`.

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
| `GEMINI_API_KEY` | Google Gemini API key (required). Get one at https://aistudio.google.com/app/apikey |
| `VERCEL_ORIGIN` | Deployed Vercel origin (e.g. `https://docucast.vercel.app`). Localhost is always allowed. |

### Frontend `.env`

| Variable | Purpose |
| --- | --- |
| `VITE_API_URL` | Public backend URL (Render/Railway in production, `http://localhost:8000` locally). |

## Stack & Model Notes

- **Gemini SDK:** uses the new `google-genai` SDK (`from google import genai`). The
  legacy `google-generativeai` package was deprecated on **August 31, 2025** and emits
  warnings; it will eventually stop working. Do not use it for new code.
- **Model:** pinned to `gemini-3.6-flash` (stable, GA July 21, 2026, free-tier
  eligible). Google retires Flash models every few months — if a call starts returning
  a 404, check the current model ID in [Google AI Studio](https://aistudio.google.com/)
  or the [models docs](https://ai.google.dev/gemini-api/docs/models) and update
  `MODEL_NAME` in `backend/utils/script_generator.py`.
- **TTS:** `edge-tts` is an unofficial wrapper around Microsoft Edge's free Read-Aloud
  endpoint. It needs no API key but can break if Microsoft changes things — fine for an
  MVP, not a long-term dependency.
- **PDF:** `pypdf` (the maintained successor to the unmaintained `PyPDF2`) handles
  text extraction. It cannot read scanned/image-only PDFs; those return a clear error.

## Deployment

### Backend (Render or Railway)

- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Set `GEMINI_API_KEY` and `VERCEL_ORIGIN` in the service's environment variables.
- A `Procfile` is included for Render/Railway compatibility.

### Frontend (Vercel)

- Root: `frontend/`
- Framework preset: Vite
- Build: `npm run build`, Output: `dist`
- Set `VITE_API_URL` to the deployed backend URL.
- `vercel.json` is included.

After the first deploy, set the backend's `VERCEL_ORIGIN` to the Vercel URL so CORS
locks down to just that origin (plus localhost for dev).

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
- **Gemini free-tier** requests may be used by Google to improve their products. Do not upload sensitive documents.

## Out of Scope (MVP)

Login, database, payments, multi-language support, analytics, cloud storage, user history, server-side file persistence, and real-time progress reporting (SSE/WebSockets).
