"""Legacy shim — PDF parsing now lives in utils.document_parser.

Kept so any old imports (`from utils.pdf_parser import extract_text_from_pdf`)
keep working after the multi-format upgrade.
"""

from utils.document_parser import clean_text, extract_text_from_pdf  # noqa: F401
