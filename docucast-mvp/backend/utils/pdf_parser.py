"""PDF text extraction and cleaning utilities for DocuCast MVP."""

from io import BytesIO
from pypdf import PdfReader

MAX_PAGES = 10
MAX_TEXT_CHARS = 8000
PAGES_LIMIT_NOTICE = "[First 10 pages processed due to MVP limit]"
TRUNCATION_NOTICE = "[Content truncated for MVP constraints]"


def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract text from the first MAX_PAGES of a PDF.

    Args:
        file_bytes: Raw PDF file bytes.

    Returns:
        Extracted text with notices appended when applicable.

    Raises:
        ValueError: If the PDF cannot be read or is encrypted.
    """
    try:
        reader = PdfReader(BytesIO(file_bytes))
    except Exception as exc:  # pragma: no cover - defensive
        raise ValueError("Unable to read PDF. The file may be corrupted.") from exc

    if reader.is_encrypted:
        # Try empty password; some PDFs are flagged encrypted but open with none.
        try:
            reader.decrypt("")
        except Exception:
            raise ValueError(
                "Encrypted PDFs are not supported. Please upload an unprotected PDF."
            )

    total_pages = len(reader.pages)
    pages_to_read = min(total_pages, MAX_PAGES)

    chunks = []
    for i in range(pages_to_read):
        try:
            page_text = reader.pages[i].extract_text() or ""
        except Exception:
            page_text = ""
        chunks.append(page_text)

    text = "\n".join(chunks)
    text = clean_text(text)

    if total_pages > MAX_PAGES:
        text = f"{text}\n\n{PAGES_LIMIT_NOTICE}"

    if len(text) > MAX_TEXT_CHARS:
        text = _truncate_on_sentence_boundary(text, MAX_TEXT_CHARS)
        text = f"{text} {TRUNCATION_NOTICE}"

    return text


def clean_text(text: str) -> str:
    """Normalize whitespace while preserving paragraph-ish breaks."""
    if not text:
        return ""

    # Collapse runs of spaces/tabs within lines, but keep up to two newlines.
    lines = text.splitlines()
    cleaned_lines = []
    for line in lines:
        stripped = " ".join(line.split())
        if stripped:
            cleaned_lines.append(stripped)

    cleaned = "\n".join(cleaned_lines)
    # Collapse 3+ newlines down to 2.
    while "\n\n\n" in cleaned:
        cleaned = cleaned.replace("\n\n\n", "\n\n")

    return cleaned.strip()


def _truncate_on_sentence_boundary(text: str, limit: int) -> str:
    """Truncate text to <= limit chars, ending at the last sentence boundary."""
    if len(text) <= limit:
        return text

    cutoff = text[:limit]
    # Look for the last sentence-ending punctuation followed by whitespace.
    last_boundary = -1
    for punctuation in (". ", "! ", "? ", ".\n", "!\n", "?\n"):
        idx = cutoff.rfind(punctuation)
        if idx > last_boundary:
            last_boundary = idx

    if last_boundary == -1:
        # Fall back to the last whitespace boundary to avoid mid-word cuts.
        last_space = cutoff.rfind(" ")
        if last_space > 0:
            return cutoff[:last_space].strip()
        return cutoff.strip()

    # Include the punctuation itself (1 char), drop the trailing whitespace.
    return cutoff[: last_boundary + 1].strip()
