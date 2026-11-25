"""Source table heading conventions shared by extraction and provenance validation."""

from dataclasses import dataclass

NOTE_HEADERS = {
    "note",
    "notes",
    "note no",
    "note no.",
    "note ref",
    "note reference",
    "schedule",
}


def has_note_heading(value: str) -> bool:
    return " ".join(value.split()).lower().strip(":.") in NOTE_HEADERS


@dataclass(frozen=True)
class RawTable:
    rows: list[list[str | None]]
    heading: str = ""
    footer: str = ""
