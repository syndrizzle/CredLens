"""Date conventions for April–March financial years."""

import re

MARCH_31_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b31\s+(?:Mar|March),?\s+(\d{4})\b", re.I),
    re.compile(r"\b(?:Mar|March)\s+31,?\s+(\d{4})\b", re.I),
    re.compile(r"\b31[-/.]0?3[-/.](\d{4})\b"),
    re.compile(r"\b(\d{4})[-/.]0?3[-/.]31\b"),
)
FY_SPAN_RE = re.compile(r"\b(?:FY\s*)?(\d{4})\s*[-–/]\s*(\d{2}|\d{4})\b", re.I)


def format_financial_year(year_start: int) -> str:
    return f"FY {year_start}-{(year_start + 1) % 100:02d}"
