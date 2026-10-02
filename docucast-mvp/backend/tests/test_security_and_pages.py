import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.main import _parse_selected_pages


def test_selected_page_lists_and_ranges():
    assert _parse_selected_pages("1,2,8") == [1, 2, 8]
    assert _parse_selected_pages("1-2,8,12-13") == [1, 2, 8, 12, 13]


def test_invalid_selected_pages_are_rejected():
    with pytest.raises(Exception):
        _parse_selected_pages("0,abc")
    with pytest.raises(Exception):
        _parse_selected_pages("8-2")


def test_empty_page_selection_means_entire_document():
    assert _parse_selected_pages(None) is None
    assert _parse_selected_pages("") is None
