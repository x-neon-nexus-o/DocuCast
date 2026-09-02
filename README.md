# DocuCast — Documents, Spoken. 🎙️

Turn **PDFs, PowerPoint decks, Markdown files and plain text** into a two-host podcast —
including what's inside your **tables, graphs, images, handwritten notes and speaker notes**.

Stack: **React + Vite + Tailwind (aurora glassmorphism UI) · FastAPI · multi-provider LLM · 4-engine TTS**.

## Why it beats NotebookLM-style audio overviews

NotebookLM's podcast feature has well-known gaps. DocuCast turns each one into a feature:

| NotebookLM loophole | DocuCast |
|---|---|
| Skips visual content — tables, charts and figures rarely make it into the audio | **Tables are parsed** (bordered *and* borderless), **PPTX chart data series are read numerically** with trend analysis, figure captions are collected, and images are OCR'd / vision-described — then *narrated* by the hosts |
| One-size-fits-all episode | Steerable studio: **two hosts or solo**, **brief / standard / deep-dive length**, **4 tones**, **4 audience profiles**, plus a **free-text focus prompt** |
| Daily generation caps & cloud lock-in | **7-provider LLM fallback chain ending in an offline engine** — generation never hits a dead end |
| Audio breaks when a cloud service does | **4-engine TTS chain**: Edge-TTS → gTTS → Piper (offline neural) → espeak-ng (offline, bundled lib). Audio *always* ships |
| Black box — you can't see what it read | **"What DocuCast actually read" panel**: every extracted table, chart, image, figure caption, handwritten note and speaker note is inspectable |
| No handwriting or scanned-note support | OCR (tesseract) + vision-LLM pipeline flags and transcribes **handwritten annotations** |
| PPT speaker notes ignored | **Hidden presenter notes are extracted** and woven into the episode |

## Supported inputs

`.pdf` · `.pptx` · `.md` / `.markdown` · `.txt` (up to 20 MB)

- **PDF** — body text (pdfplumber + pypdf), tables (line & text strategies with false-positive guards), embedded images, figure/graph captions, handwriting detection
- **PPTX** — slide text, tables, **native chart data (categories + series values + trend)**, pictures, speaker notes
- **Markdown** — body, tables, image alt-text, code-block summarization
- **TXT** — encoding-detected plain text

## AI limits finished? Free unlimited alternatives

Backend auto-falls back — no code change needed:

```
Gemini → Groq (free) → OpenRouter (free) → Cerebras → HuggingFace → Ollama (offline) → Local (always)
```

**Fastest fix (30 sec) — Groq FREE 14k req/day:**
```bash
# 1. Get key at https://console.groq.com/keys (no CC)
# 2. In docucast-mvp/backend/.env add:
GROQ_API_KEY=gsk_xxx...
LLM_PROVIDER=auto
```

**Unlimited offline, no key ever:** `LLM_PROVIDER=local` (or install [Ollama](https://ollama.com)).

**Vision / image understanding (optional):** set `GEMINI_API_KEY` or `OPENROUTER_API_KEY`
(free vision models) and DocuCast will describe charts, transcribe handwriting and read
text inside images. Install the `tesseract` binary for local OCR.

Check `GET /providers` to see what's ready.

## Quick Start

```bash
# Backend
cd docucast-mvp/backend
pip install -r requirements.txt
uvicorn main:app --reload            # http://localhost:8000

# Frontend
cd docucast-mvp/frontend
npm install
npm run dev                           # http://localhost:5173 (proxies /api → :8000)
```

Default dev login: `admin` / `docucast` (override with `DOCUCAST_USERNAME` / `DOCUCAST_PASSWORD`).

## Project

- `docucast-mvp/backend` — FastAPI · document intelligence (`utils/document_parser.py`, `utils/vision.py`) · steerable script generation (`utils/script_generator.py`) · multi-voice TTS (`utils/tts_engine.py`)
- `docucast-mvp/frontend` — React aurora-glass UI: cinematic scroll reveals, custom audio player, extraction inspector, full accessibility (reduced-motion, focus rings, ARIA)

See `docucast-mvp/README.md` for full details.
