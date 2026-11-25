import re
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import Field, StringConstraints, field_validator, model_validator

from app.pdf_format import has_note_heading
from app.pdf_limits import (
    MAX_PDF_BYTES,
    MAX_PDF_PAGES,
    MAX_TABLES_PER_PAGE,
    MAX_TABLE_ROWS_PER_PAGE,
    MAX_TABLE_COLS,
    MAX_CELL_CHARS,
    MAX_PAGE_TEXT_LENGTH,
    MAX_TEXT_CHARS,
    MAX_CANDIDATES,
    MAX_TOTAL_TEXT_LENGTH,
    MAX_TOTAL_TABLE_ROWS,
    MAX_TOTAL_TABLE_CELLS,
)
from app.schemas.base import Model
from app.schemas.financial import DecimalValue, FinancialField, UNIT_MULTIPLIERS, Unit


class DocumentSummary(Model):
    id: UUID
    business_id: UUID
    filename: str
    sha256: str
    byte_size: int = Field(ge=1, le=MAX_PDF_BYTES)
    page_count: int | None = Field(default=None, ge=1, le=MAX_PDF_PAGES)
    extracted_char_count: int | None = Field(default=None, ge=0)
    status: Literal["processing", "ready", "failed"]
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime


CandidateIssueCode = Literal[
    "missing_value",
    "invalid_amount",
    "ambiguous_mapping",
    "missing_unit",
    "conflicting_unit",
    "missing_period",
    "conflicting_period",
    "missing_basis",
    "conflicting_basis",
    "duplicate_match",
    "conflicting_match",
]


class ExtractedTable(Model):
    table_index: int = Field(ge=1, le=MAX_TABLES_PER_PAGE)
    rows: list[list[str]] = Field(min_length=1, max_length=MAX_TABLE_ROWS_PER_PAGE)

    @model_validator(mode="after")
    def check_cells(self) -> Self:
        for row in self.rows:
            if not 1 <= len(row) <= MAX_TABLE_COLS:
                raise ValueError("Extracted table rows must have 1 to 16 columns")
            if any(len(cell) > MAX_CELL_CHARS for cell in row):
                raise ValueError(
                    "Extracted table cells must not exceed 1,000 characters"
                )
        return self


class ExtractedPage(Model):
    page_number: int = Field(ge=1, le=MAX_PDF_PAGES)
    text: str = Field(max_length=MAX_PAGE_TEXT_LENGTH)
    tables: list[ExtractedTable] = Field(default_factory=list, max_length=MAX_TABLES_PER_PAGE)
    statement_title: str | None = Field(default=None, max_length=MAX_CELL_CHARS)
    basis: Literal["standalone"] | None = None
    basis_context: str | None = Field(default=None, max_length=MAX_CELL_CHARS)
    period_context: str | None = Field(default=None, max_length=MAX_CELL_CHARS)
    unit: Unit | None = None
    multiplier: int | None = None
    unit_header: str | None = Field(default=None, max_length=MAX_CELL_CHARS)
    issues: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_page_unit(self) -> Self:
        if (self.unit is None) != (self.multiplier is None):
            raise ValueError(
                "Page unit and multiplier must both be set or both be null"
            )
        if self.unit is not None and UNIT_MULTIPLIERS[self.unit] != self.multiplier:
            raise ValueError("Page unit and multiplier do not match")
        if sum(len(table.rows) for table in self.tables) > MAX_TABLE_ROWS_PER_PAGE:
            raise ValueError("Extracted page exceeds maximum table row budget")
        return self


class ExtractedCandidate(Model):
    page_number: int = Field(ge=1, le=MAX_PDF_PAGES)
    table_index: int = Field(ge=1, le=MAX_TABLES_PER_PAGE)
    row_index: int = Field(ge=1, le=MAX_TABLE_ROWS_PER_PAGE)
    column_index: int = Field(ge=1, le=MAX_TABLE_COLS)
    field: FinancialField | None = None
    label: str = Field(max_length=MAX_CELL_CHARS)
    note: str | None = Field(default=None, max_length=MAX_CELL_CHARS)
    raw: str = Field(max_length=MAX_CELL_CHARS)
    source_row: list[str] = Field(min_length=1, max_length=MAX_TABLE_COLS)
    source_context: list[str] = Field(default_factory=list, max_length=20)
    period_header: str = Field(max_length=MAX_CELL_CHARS)
    period_context: str | None = Field(default=None, max_length=MAX_CELL_CHARS)
    year_start: int | None = Field(default=None, ge=1, le=9998)
    unit_header: str | None = Field(default=None, max_length=MAX_CELL_CHARS)
    unit: Unit | None = None
    multiplier: int | None = None
    basis: Literal["standalone"] | None = None
    basis_context: str | None = Field(default=None, max_length=MAX_CELL_CHARS)
    amount: DecimalValue | None = None
    normalized_inr: DecimalValue | None = None
    reviewed: Literal[False] = False
    issues: list[CandidateIssueCode] = Field(default_factory=list, max_length=12)

    @field_validator("amount", "normalized_inr", mode="before")
    @classmethod
    def parse_decimal_string(cls, value: object) -> Decimal | None:
        if value is None or isinstance(value, Decimal):
            return value
        if isinstance(value, str) and re.fullmatch(
            r"-?[0-9]{1,23}(?:\.[0-9]{1,2})?", value
        ):
            return Decimal(value)
        raise ValueError("Decimal fields require a canonical decimal string or Decimal")

    @model_validator(mode="after")
    def check_candidate(self) -> Self:
        if (self.unit is None) != (self.multiplier is None):
            raise ValueError(
                "Candidate unit and multiplier must both be set or both be null"
            )
        if self.unit is not None and UNIT_MULTIPLIERS[self.unit] != self.multiplier:
            raise ValueError("Candidate unit and multiplier do not match")
        if self.issues:
            if self.normalized_inr is not None:
                raise ValueError(
                    "Candidates with issues must not have a usable normalized INR value"
                )
        else:
            if (
                self.field is None
                or self.year_start is None
                or self.unit is None
                or self.multiplier is None
                or self.basis != "standalone"
                or self.amount is None
                or self.normalized_inr is None
            ):
                raise ValueError(
                    "Usable candidates require field, year, unit, multiplier, standalone basis, amount, and normalized INR"
                )
            if self.normalized_inr != self.amount * Decimal(self.multiplier):
                raise ValueError(
                    "Normalized INR must equal exact amount times multiplier"
                )
        return self


class DocumentExtractionSnapshot(Model):
    schema_version: Literal["document-extraction-v2"]
    document_sha256: Annotated[
        str, StringConstraints(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    ]
    layout: Literal["layout_a", "unsupported"]
    page_count: int = Field(ge=1, le=MAX_PDF_PAGES)
    extracted_char_count: int = Field(ge=1, le=MAX_TEXT_CHARS)
    pages: list[ExtractedPage] = Field(min_length=1, max_length=MAX_PDF_PAGES)
    candidates: list[ExtractedCandidate] = Field(default_factory=list, max_length=MAX_CANDIDATES)
    issues: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def check_snapshot_bounds(self) -> Self:
        if len(self.pages) != self.page_count:
            raise ValueError("Page list length must match page_count")
        if [page.page_number for page in self.pages] != list(
            range(1, self.page_count + 1)
        ):
            raise ValueError("Pages must be numbered sequentially from 1 to page_count")
        if sum(len(page.text) for page in self.pages) > MAX_TOTAL_TEXT_LENGTH:
            raise ValueError("Total extracted text exceeds budget")
        total_rows = sum(
            len(table.rows) for page in self.pages for table in page.tables
        )
        total_cells = sum(
            len(row)
            for page in self.pages
            for table in page.tables
            for row in table.rows
        )
        if total_rows > MAX_TOTAL_TABLE_ROWS or total_cells > MAX_TOTAL_TABLE_CELLS:
            raise ValueError("Total extracted table rows or cells exceed budget")
        tables = {
            (p.page_number, t.table_index): t for p in self.pages for t in p.tables
        }
        if len(tables) != sum(len(p.tables) for p in self.pages):
            raise ValueError("Duplicate table reference")
        for candidate in self.candidates:
            table = tables.get((candidate.page_number, candidate.table_index))
            if table is None or not 2 <= candidate.row_index <= len(table.rows):
                raise ValueError("Candidate refers to an absent source row")
            row = table.rows[candidate.row_index - 1]
            header = table.rows[0]
            has_note = len(header) > 1 and has_note_heading(header[1])
            note = row[1] if has_note and len(row) > 1 else None
            col = candidate.column_index - 1
            if not (
                (2 if has_note else 1) <= col < min(len(row), len(header))
                and candidate.note == note
                and candidate.source_row == row
                and candidate.label == row[0]
                and candidate.raw == row[col]
                and candidate.period_header == header[col]
            ):
                raise ValueError("Candidate source cell differs from retained table")
        return self


class DocumentExtractionResponse(DocumentSummary):
    extraction_status: Literal[
        "ready",
        "not_extracted",
        "refresh_required",
        "processing",
        "failed",
        "deletion_pending",
    ]
    extraction_message: str | None = None
    extraction: DocumentExtractionSnapshot | None = None

    @model_validator(mode="after")
    def check_extraction_exposure(self) -> Self:
        if self.extraction_status == "ready":
            if self.status != "ready" or self.extraction is None:
                raise ValueError(
                    "Ready extraction status requires ready document and snapshot"
                )
            if self.extraction.document_sha256 != self.sha256:
                raise ValueError(
                    "Extraction snapshot hash does not match document sha256"
                )
        elif self.extraction is not None:
            raise ValueError("Non-ready extraction status must not expose a snapshot")
        return self
