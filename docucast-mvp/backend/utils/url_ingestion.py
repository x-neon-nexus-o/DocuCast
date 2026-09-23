"""URL and YouTube ingestion pipeline for DocuCast.

Turns article links and YouTube URLs into structured ParsedDocuments
that feed directly into the podcast script generation pipeline.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup
import requests
import yt_dlp

from backend.utils.document_parser import ParsedDocument

YOUTUBE_RE = re.compile(
    r"^(https?://)?(www\.|m\.)?(youtube\.com/(watch\?v=|embed/|v/|shorts/)|youtu\.be/)([\w\-]{11})",
    re.IGNORECASE,
)

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


def is_youtube_url(url: str) -> bool:
    """Return True if the URL points to a YouTube video or short."""
    return bool(YOUTUBE_RE.search(url.strip()))


def extract_youtube_video_id(url: str) -> Optional[str]:
    """Extract the 11-character YouTube video ID."""
    match = YOUTUBE_RE.search(url.strip())
    if match:
        return match.group(5)
    return None


def _clean_vtt(vtt_text: str) -> str:
    """Strip WebVTT timestamps and metadata to produce plain narration text."""
    lines = []
    seen = set()
    for raw in vtt_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
            continue
        if "-->" in line:
            continue
        # Strip simple formatting tags like <c> </c> <00:01:23.000>
        line = re.sub(r"<[^>]+>", "", line).strip()
        if not line or line in seen:
            continue
        seen.add(line)
        lines.append(line)
    return " ".join(lines)


def _parse_json3_subtitles(json3_data: dict) -> str:
    """Extract plain text transcript from YouTube json3 subtitle format."""
    events = json3_data.get("events", [])
    sentences = []
    for ev in events:
        segs = ev.get("segs", [])
        for s in segs:
            text = s.get("utf8", "").strip()
            if text and text != "\n":
                sentences.append(text)
    return " ".join(sentences)


def extract_youtube_content(url: str) -> ParsedDocument:
    """Fetch YouTube metadata and transcript, returning a ParsedDocument."""
    ydl_opts = {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en.*", "en", "en-US", "en-GB"],
        "quiet": True,
        "no_warnings": True,
        "extract_flat": False,
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:
        raise ValueError(f"Could not load YouTube video: {exc}") from exc

    if not info:
        raise ValueError("No video information could be retrieved from YouTube.")

    title = info.get("title") or "YouTube Video"
    channel = info.get("uploader") or info.get("channel") or "Unknown Creator"
    description = (info.get("description") or "").strip()
    duration = info.get("duration") or 0
    chapters = info.get("chapters") or []

    # Attempt to extract English transcript/subtitles
    transcript_text = ""
    subtitles = info.get("subtitles") or {}
    auto_captions = info.get("automatic_captions") or {}

    caption_dict = {**auto_captions, **subtitles}  # manual subs take precedence if merged reversed
    # Prefer manual subtitles
    for lang, entries in subtitles.items():
        if lang.startswith("en"):
            caption_dict[lang] = entries

    en_keys = [k for k in caption_dict if k.startswith("en")]
    target_formats = None
    if en_keys:
        target_formats = caption_dict[en_keys[0]]

    if target_formats:
        # Prefer json3 or vtt format
        json3_url = next((f["url"] for f in target_formats if f.get("ext") == "json3"), None)
        vtt_url = next((f["url"] for f in target_formats if f.get("ext") == "vtt"), None)
        other_url = target_formats[0].get("url") if target_formats else None

        chosen_url = json3_url or vtt_url or other_url
        if chosen_url:
            try:
                resp = requests.get(chosen_url, headers={"User-Agent": USER_AGENT}, timeout=10)
                if resp.status_code == 200:
                    if json3_url:
                        transcript_text = _parse_json3_subtitles(resp.json())
                    else:
                        transcript_text = _clean_vtt(resp.text)
            except Exception:
                transcript_text = ""

    # Assemble narration brief
    sections = [f"=== YOUTUBE VIDEO: {title} ===", f"Channel: {channel}"]
    if duration:
        m, s = divmod(duration, 60)
        sections.append(f"Duration: {m}m {s}s")

    if chapters:
        ch_lines = ["=== CHAPTER MARKERS ==="]
        for ch in chapters:
            start_m, start_s = divmod(int(ch.get("start_time", 0)), 60)
            ch_lines.append(f"- [{start_m:02d}:{start_s:02d}] {ch.get('title', 'Chapter')}")
        sections.append("\n".join(ch_lines))

    warnings = []
    if transcript_text:
        sections.append(f"=== SPOKEN VIDEO TRANSCRIPT ===\n{transcript_text}")
    else:
        warnings.append("No closed captions were found for this video; using video description and chapters.")
        if description:
            # Include first 4000 characters of description
            sections.append(f"=== VIDEO DESCRIPTION & OVERVIEW ===\n{description[:4000]}")

    full_text = "\n\n".join(sections)

    return ParsedDocument(
        doc_type="youtube",
        text=full_text,
        stats={
            "title": title,
            "channel": channel,
            "duration": duration,
            "has_transcript": bool(transcript_text),
            "chapters_count": len(chapters),
        },
        warnings=warnings,
    )


def extract_article_content(url: str) -> ParsedDocument:
    """Scrape and parse article content from a web URL, returning a ParsedDocument."""
    try:
        response = requests.get(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=15,
        )
        response.raise_for_status()
    except Exception as exc:
        raise ValueError(f"Could not load webpage ({url}): {exc}") from exc

    soup = BeautifulSoup(response.text, "html.parser")

    # Remove non-content elements
    for tag in soup(["script", "style", "nav", "footer", "header", "aside", "noscript", "svg", "form", "iframe"]):
        tag.decompose()

    # Remove known ad / cookie / sidebar classes
    for element in soup.find_all(attrs={"class": re.compile(r"cookie|banner|advert|ad-|sidebar|promo|popup", re.I)}):
        element.decompose()

    # Extract title
    title = ""
    og_title = soup.find("meta", property="og:title")
    if og_title and og_title.get("content"):
        title = og_title["content"].strip()
    elif soup.title and soup.title.string:
        title = soup.title.string.strip()
    elif soup.h1:
        title = soup.h1.get_text().strip()
    if not title:
        title = urllib.parse.urlparse(url).netloc

    # Extract site name / domain
    domain = urllib.parse.urlparse(url).netloc

    # Find the main container if available
    main_container = soup.find("article") or soup.find("main") or soup.find(attrs={"role": "main"})
    if not main_container:
        # Fall back to body
        main_container = soup.body or soup

    # Extract paragraphs and headings
    body_parts: list[str] = []
    tables: list[dict] = []

    # Extract HTML tables
    for idx, table in enumerate(main_container.find_all("table")[:6]):
        rows = []
        for tr in table.find_all("tr"):
            cells = [c.get_text().strip().replace("\n", " ") for c in tr.find_all(["th", "td"])]
            if cells:
                rows.append(" | ".join(cells))
        if rows:
            table_md = "\n".join(rows)
            table_narration = f"Table {idx + 1} from {domain}: {table_md[:500]}"
            tables.append({
                "page": 1,
                "title": f"Table {idx + 1}",
                "markdown": table_md,
                "narration": table_narration,
            })

    # Walk children for headings and paragraphs
    for el in main_container.find_all(["h1", "h2", "h3", "h4", "p", "blockquote", "li"]):
        txt = el.get_text().strip()
        if not txt or len(txt) < 15:
            continue
        if el.name in {"h1", "h2", "h3", "h4"}:
            body_parts.append(f"\n## {txt}\n")
        elif el.name == "blockquote":
            body_parts.append(f"> \"{txt}\"")
        elif el.name == "li":
            body_parts.append(f"* {txt}")
        else:
            body_parts.append(txt)

    article_text = "\n\n".join(body_parts).strip()
    if not article_text:
        # Fall back to get_text
        article_text = main_container.get_text(separator="\n", strip=True)

    if not article_text:
        raise ValueError(f"No readable article text could be extracted from {url}.")

    full_narrative = (
        f"=== ARTICLE SOURCE: {title} ===\n"
        f"URL: {url} ({domain})\n\n"
        f"=== ARTICLE CONTENT ===\n"
        f"{article_text[:14000]}"
    )

    return ParsedDocument(
        doc_type="web",
        text=full_narrative,
        tables=tables,
        stats={
            "title": title,
            "domain": domain,
            "url": url,
            "char_count": len(article_text),
            "tables_found": len(tables),
        },
    )


def ingest_url(url: str) -> ParsedDocument:
    """Dispatcher: fetch and parse YouTube or standard article URLs."""
    url = url.strip()
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    if is_youtube_url(url):
        return extract_youtube_content(url)
    return extract_article_content(url)
