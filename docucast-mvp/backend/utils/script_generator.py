"""Gemini script generation for DocuCast MVP.

Uses the current Google Gen AI SDK (`google-genai`, package `google.genai`).
The legacy `google-generativeai` package was deprecated on August 31, 2025.
See: https://github.com/googleapis/python-genai
"""

from google import genai
from google.genai import types

# Current stable free-tier-eligible Flash model (GA July 21, 2026).
# Check https://ai.google.dev/gemini-api/docs/models before bumping.
MODEL_NAME = "gemini-3.6-flash"
MAX_OUTPUT_TOKENS = 800
TEMPERATURE = 0.7

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


def generate_script(text: str, api_key: str) -> str:
    """Generate a podcast-style script from document text via Gemini.

    Args:
        text: Extracted and cleaned document text.
        api_key: Google Gemini API key.

    Returns:
        The generated script as plain text.

    Raises:
        ValueError: On a model/API error or empty response.
    """
    if not api_key:
        raise ValueError("GEMINI_API_KEY is not configured on the server.")

    client = genai.Client(api_key=api_key)

    user_prompt = (
        f"Document:\n{text}\n\n"
        "Generate the podcast script now."
    )

    try:
        response = client.models.generate_content(
            model=MODEL_NAME,
            contents=user_prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                temperature=TEMPERATURE,
                max_output_tokens=MAX_OUTPUT_TOKENS,
            ),
        )
    except Exception as exc:
        raise ValueError(f"Gemini script generation failed: {exc}") from exc

    script = (getattr(response, "text", "") or "").strip()

    if not script:
        # Surface finish/block reason if available.
        reason = ""
        try:
            candidate = response.candidates[0] if response.candidates else None
            if candidate and candidate.finish_reason:
                reason = f" (finish reason: {candidate.finish_reason})"
        except Exception:
            pass
        raise ValueError(
            "Gemini returned an empty or blocked response"
            f"{reason}. Please try a different PDF."
        )

    return script
