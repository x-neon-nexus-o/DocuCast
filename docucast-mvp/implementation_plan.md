# Tier 2 Features & MongoDB Storage Migration

Implement Tier 2 features (URL & YouTube ingestion, interactive click-to-seek transcript, and batch mode/playlists) and replace SQLite with MongoDB so user registration, login, sessions, episodes, and playlists are all managed through MongoDB and inspectable in MongoDB Compass.

---

## User Review Required

> [!IMPORTANT]
> **MongoDB Requirement**:
> - We detected MongoDB 8.2.3 running locally on `mongodb://localhost:27017`.
> - We will use the database named `docucast`. You can open MongoDB Compass, connect to `mongodb://localhost:27017`, and inspect the `docucast` database with collections: `users`, `sessions`, `episodes`, `chat_messages`, and `playlists`.
> - SQLite (`docucast.db`) will be decommissioned from auth and episode persistence.

> [!NOTE]
> **Dependencies**:
> - `pymongo`, `yt-dlp`, `bs4`, and `mutagen` are already installed in your virtual environment (`backend/.venv`). We will formally add `pymongo` to `requirements.txt` to keep it documented.

---

## Proposed Changes

### Component 1: Database Migration to MongoDB (`backend/utils/auth.py` & `.env`)

Replace SQLite database operations in `auth.py` with `pymongo`. All authentication, session tokens, episode archives, chat history, and playlists will be stored as documents in MongoDB.

#### [MODIFY] [backend/.env](file:///e:/DocuCast-New/docucast-mvp/backend/.env)
- Add `MONGODB_URI=mongodb://localhost:27017`
- Add `MONGODB_DB_NAME=docucast`

#### [MODIFY] [backend/requirements.txt](file:///e:/DocuCast-New/docucast-mvp/backend/requirements.txt)
- Add `pymongo>=4.0.0`
- Add `mutagen>=1.46.0`

#### [MODIFY] [backend/utils/auth.py](file:///e:/DocuCast-New/docucast-mvp/backend/utils/auth.py)
- Replace `sqlite3` with `pymongo.MongoClient`.
- Collections:
  - `users`: `{_id, username, password_hash, created_at}` (Unique index on `username`).
  - `sessions`: `{_id, user_id, username, token_hash, created_at, expires_at, last_used_at}` (Index on `token_hash`).
  - `episodes`: `{_id, user_id, username, filename, doc_type, mode, length, tone, audience, focus, provider, audio_engine, audio_mime, script, audio_base64, transcript_segments, analysis, source_text, show_notes, playlist_id, created_at}` (Index on `username`, `created_at`).
  - `chat_messages`: `{_id, episode_id, username, role, content, created_at}`.
  - `playlists`: `{_id, user_id, username, title, description, episode_ids, created_at}`.
- Methods updated:
  - `initialize_database()`: Connect to MongoDB, ensure unique index on `users.username`, index on `sessions.token_hash`, indexes on `episodes`, `chat_messages`, and `playlists`.
  - `ensure_user()`, `authenticate_user()`, `register_user()`, `reset_password()`.
  - `create_session()`, `verify_session()`, `revoke_session()`.
  - `save_episode()`, `list_episodes()`, `get_episode()`, `delete_episode()`, `update_episode_script()`, `get_episode_source()`.
  - `add_chat_message()`, `list_chat_messages()`, `clear_chat_messages()`.
  - New Playlist methods: `save_playlist()`, `list_playlists()`, `get_playlist()`, `delete_playlist()`, `add_episode_to_playlist()`.

---

### Component 2: Feature 4 — URL & YouTube Ingestion

Add a specialized URL ingestion engine supporting YouTube videos (extracting transcripts and video metadata via `yt-dlp`) and web articles (extracting structured text, headings, and tables via `BeautifulSoup4`).

#### [NEW] [backend/utils/url_ingestion.py](file:///e:/DocuCast-New/docucast-mvp/backend/utils/url_ingestion.py)
- `is_youtube_url(url: str) -> bool`: Regex detection for YouTube watch, share, and shorts links.
- `extract_youtube_content(url: str) -> ParsedDocument`:
  - Uses `yt-dlp` to extract video info: title, uploader/channel, upload date, duration, description, chapters.
  - Extracts English subtitles/closed captions or automatic speech recognition transcript if available.
  - Formats clean timestamps and narrative brief into a `ParsedDocument(doc_type="youtube", ...)`.
- `extract_article_content(url: str) -> ParsedDocument`:
  - Fetches URL content with browser User-Agent and timeout handling.
  - Cleans HTML (removes nav, footer, scripts, styles, ads, cookie popups).
  - Extracts title, author, publish date, lead text, paragraphs, headings, blockquotes, and tables.
  - Returns `ParsedDocument(doc_type="web", ...)`.
- `ingest_url(url: str) -> ParsedDocument`: Unified dispatcher.

#### [MODIFY] [backend/main.py](file:///e:/DocuCast-New/docucast-mvp/backend/main.py)
- Support `url: Optional[str] = Form(None)` in `/generate`.
- Allow `/generate` with either uploaded files OR a valid URL.
- Add `/ingest-preview` endpoint to let users preview the extracted title, source, and text snippet before generating.

---

### Component 3: Feature 5 — Interactive Transcript (Click-to-Seek)

Capture per-segment duration during audio synthesis to output an exact `[{speaker, text, start, end}]` timeline. Wire this into the frontend audio player and transcript UI for interactive click-to-seek and real-time sentence/turn highlighting.

#### [MODIFY] [backend/utils/tts_engine.py](file:///e:/DocuCast-New/docucast-mvp/backend/utils/tts_engine.py)
- Update dialogue synthesis functions (`_synthesize_all_edge`, `_synthesize_all_gtts`, `_synthesize_all_piper`, `_synthesize_all_espeak`) to measure segment audio durations:
  - For MP3 (Edge-TTS and gTTS): use `mutagen.File` / `mutagen.mp3.MP3` on the segment bytes to get exact duration.
  - For WAV (Piper and espeak-ng): exact duration calculated from PCM byte length: `len(pcm) / (sample_rate * 2)`.
- Generate `segments_timeline`:
  ```python
  [
      {"speaker": "NOVA", "text": "...", "start": 0.0, "end": 4.12},
      {"speaker": "RHYS", "text": "...", "start": 4.12, "end": 9.45},
  ]
  ```
- Return `(audio_bytes, engine_name, mime_type, segments_timeline)` from `generate_audio()`.

#### [MODIFY] [backend/main.py](file:///e:/DocuCast-New/docucast-mvp/backend/main.py)
- Include `transcript_segments` in generation payload and store it in MongoDB episode document.
- Pass `transcript_segments` in `/episodes/{id}` and `/jobs/{id}` responses.

#### [MODIFY] [frontend/src/components/ResultSection.jsx](file:///e:/DocuCast-New/docucast-mvp/frontend/src/components/ResultSection.jsx)
- Update transcript rendering to display interactive turns:
  - Show timecode chip (e.g., `00:04`) next to the speaker chip.
  - Highlight the currently playing turn (with subtle aurora glow and active badge) synchronized with `currentTime`.
  - Click any turn or sentence to seek audio to that exact moment (`audioRef.current.currentTime = turn.start`) and resume playback.
  - Add smooth auto-scroll to the currently active dialogue turn during playback (with toggle to pause auto-scroll if user manually scrolls).

---

### Component 4: Feature 6 — Batch Mode & Playlists

Enable queuing multiple documents or URLs (e.g., lecture series, course modules, chapter sets) into a single batch job that generates a cohesive playlist with continuous playback.

#### [MODIFY] [backend/main.py](file:///e:/DocuCast-New/docucast-mvp/backend/main.py)
- Add `POST /batch-generate`:
  - Accepts multiple files and/or a list of URLs, plus a `playlist_title`, `description`, and podcast options.
  - Launches a background job that processes each item in sequence, reporting progress across the series (e.g. `Episode 2 of 4: Synthesizing voices`).
  - Creates a playlist in MongoDB linking all generated episode IDs.
- Add Playlist endpoints:
  - `GET /playlists`: list playlists with episode counts, titles, total durations.
  - `GET /playlists/{id}`: get playlist with full episode list.
  - `DELETE /playlists/{id}`: delete playlist.

#### [NEW] [frontend/src/components/PlaylistSection.jsx](file:///e:/DocuCast-New/docucast-mvp/frontend/src/components/PlaylistSection.jsx)
- Dedicated Playlist view:
  - View user playlists with episode count, total audio duration, and date.
  - Playlist Player: seamless continuous playback (auto-advances to the next episode when one finishes).
  - Quick playlist track switcher with track durations and format icons.

#### [MODIFY] [frontend/src/components/UploadSection.jsx](file:///e:/DocuCast-New/docucast-mvp/frontend/src/components/UploadSection.jsx)
- Add Mode Switcher at top: "Single Document", "Link / YouTube", "Batch Series / Playlist".
- For "Link / YouTube": URL input box with instant validation (YouTube vs Article link), title preview, and one-click generate.
- For "Batch Series / Playlist": Drop multiple files or paste multiple links, provide a Series / Playlist title, and click "Generate Playlist".

#### [MODIFY] [frontend/src/App.jsx](file:///e:/DocuCast-New/docucast-mvp/frontend/src/App.jsx)
- Add "Playlists" navigation tab alongside "Dashboard" and "Studio".
- Support batch generation job polling and playlist playback state.

---

## Verification Plan

### Automated Tests
- Test MongoDB connection and CRUD operations:
  ```powershell
  backend\.venv\Scripts\python -c "from utils.auth import initialize_database, register_user, authenticate_user, create_session, verify_session; initialize_database(); register_user('testuser', 'testpass123'); assert authenticate_user('testuser', 'testpass123'); token = create_session('testuser', 3600); assert verify_session(token) == 'testuser'; print('MongoDB auth test passed!')"
  ```
- Test URL & YouTube Ingestion:
  ```powershell
  backend\.venv\Scripts\python -c "from utils.url_ingestion import ingest_url; doc = ingest_url('https://en.wikipedia.org/wiki/Podcast'); print('Ingested wiki:', doc.doc_type, len(doc.text), 'chars'); assert len(doc.text) > 100"
  ```
- Test Segment Timestamps:
  ```powershell
  backend\.venv\Scripts\python -c "from utils.tts_engine import generate_audio; audio, engine, mime, timeline = generate_audio('NOVA: Welcome to DocuCast.\nRHYS: Glad to be here today!'); print('Engine:', engine, 'Timeline count:', len(timeline), timeline); assert len(timeline) >= 2"
  ```

### Manual Verification
1. **MongoDB Compass Inspection**:
   - Open MongoDB Compass, connect to `mongodb://localhost:27017`.
   - Register a new user in the DocuCast UI or log in.
   - Verify documents are created in `docucast.users` and `docucast.sessions`.
2. **URL / YouTube Ingestion**:
   - Paste a YouTube video link or article link into the UI.
   - Verify podcast script and audio generation succeed.
3. **Interactive Click-to-Seek Transcript**:
   - Play the generated episode.
   - Click on different speaker turns in the transcript and observe the audio immediately seeking to that turn.
   - Observe the active sentence/turn glowing in sync with the audio playback.
4. **Batch Mode & Playlists**:
   - Queue 2-3 documents or links under a playlist title.
   - Verify batch completion, view playlist in the Playlists tab, and test continuous playback.
