"""Bounded Layout A candidate extraction for digital financial statement PDFs."""
from datetime import date, datetime
from decimal import Decimal
import re
from zoneinfo import ZoneInfo

from app.pdf_limits import (
    MAX_CANDIDATES,
    MAX_CELL_CHARS,
    MAX_PAGE_TEXT_LENGTH,
    MAX_TABLE_COLS,
    MAX_TABLE_ROWS_PER_PAGE,
    MAX_TABLES_PER_PAGE,
    MAX_TOTAL_TABLE_CELLS,
    MAX_TOTAL_TABLE_ROWS,
    MAX_TOTAL_TEXT_LENGTH,
)
from app.schemas import (
    UNIT_MULTIPLIERS,
    CandidateIssueCode,
    DocumentExtractionSnapshot,
    ExtractedCandidate,
    ExtractedPage,
    ExtractedTable,
    FinancialField,
    Unit,
)


class ExtractionLimitExceeded(Exception):
    pass


LABEL_HEADERS = {"particulars", "line item", "line items", "item", "items", "description"}
NOTE_HEADERS = {"note", "notes", "note no", "note no.", "note ref", "note reference", "schedule"}

FIELD_LABELS: dict[str, FinancialField] = {
    "revenue from operations": "revenue",
    "revenue from operations (net)": "revenue",
    "operating revenue": "revenue",
    "profit after tax": "profit_after_tax",
    "profit / (loss) after tax": "profit_after_tax",
    "profit/(loss) after tax": "profit_after_tax",
    "profit or loss after tax": "profit_after_tax",
    "profit (loss) after tax": "profit_after_tax",
    "loss after tax": "profit_after_tax",
    "net profit after tax": "profit_after_tax",
    "profit after tax for the year": "profit_after_tax",
    "profit or loss after tax for the year": "profit_after_tax",
    "earnings before interest and tax": "ebit",
    "earnings before interest and taxes": "ebit",
    "ebit": "ebit",
    "operating profit before interest and tax": "ebit",
    "profit before interest and tax": "ebit",
    "interest expense": "interest_expense",
    "interest on borrowings": "interest_expense",
    "interest expense on borrowings": "interest_expense",
    "total current assets": "current_assets",
    "current assets": "current_assets",
    "total current liabilities": "current_liabilities",
    "current liabilities": "current_liabilities",
    "total assets": "total_assets",
    "total liabilities excluding equity": "total_liabilities",
    "total liabilities (excluding equity)": "total_liabilities",
    "all liabilities excluding equity": "total_liabilities",
    "total liabilities": "total_liabilities",
    "total equity": "total_equity",
    "total shareholders' equity": "total_equity",
    "total shareholders equity": "total_equity",
    "shareholders' equity": "total_equity",
    "shareholders equity": "total_equity",
    "short-term borrowings": "short_term_borrowings",
    "short term borrowings": "short_term_borrowings",
    "short-term borrowings (excluding current maturities)": "short_term_borrowings",
    "current borrowings (excluding current maturities)": "short_term_borrowings",
    "non-current borrowings": "long_term_borrowings",
    "non current borrowings": "long_term_borrowings",
    "long-term borrowings": "long_term_borrowings",
    "long term borrowings": "long_term_borrowings",
    "current maturities of long-term borrowings": "current_maturities",
    "current maturities of long term borrowings": "current_maturities",
    "current maturities of long-term debt": "current_maturities",
    "current maturities of long term debt": "current_maturities",
    "current maturities of non-current borrowings": "current_maturities",
}

UNIT_PATTERNS: tuple[tuple[re.Pattern[str], Unit], ...] = (
    (re.compile(r"\brupees?\b", re.I), "rupees"),
    (re.compile(r"\bthousands?\b", re.I), "thousands"),
    (re.compile(r"\blakhs?\b", re.I), "lakhs"),
    (re.compile(r"\bcrores?\b", re.I), "crores"),
)
UNSUPPORTED_UNIT_RE = re.compile(r"\b(?:millions?|billions?|usd|eur|gbp|jpy)\b|[$€£¥]", re.I)

NON_MARCH_DATE_RE = re.compile(
    r"\b\d{1,2}\s+(?:Jan|January|Feb|February|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+\d{4}\b"
    r"|\b(?:Jan|January|Feb|February|Apr|April|May|Jun|June|Jul|July|Aug|August|Sep|Sept|September|Oct|October|Nov|November|Dec|December)\s+\d{1,2},?\s+\d{4}\b"
    r"|\b(?:[012]?\d|30)\s+(?:Mar|March),?\s+\d{4}\b",
    re.I,
)
MARCH_31_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b31\s+(?:Mar|March),?\s+(\d{4})\b", re.I),
    re.compile(r"\b(?:Mar|March)\s+31,?\s+(\d{4})\b", re.I),
    re.compile(r"\b31[-/.]0?3[-/.](\d{4})\b"),
    re.compile(r"\b(\d{4})[-/.]0?3[-/.]31\b"),
)
FY_SPAN_RE = re.compile(r"\b(?:FY\s*)?(\d{4})\s*[-–/]\s*(\d{2}|\d{4})\b", re.I)
PLAIN_INT_RE = re.compile(r"0|[1-9][0-9]{0,14}")
INTL_GROUP_RE = re.compile(r"[1-9][0-9]{0,2}(?:,[0-9]{3})+")
INDIAN_GROUP_RE = re.compile(r"[1-9][0-9]?(?:,[0-9]{2})*,[0-9]{3}")


def _normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _map_label_to_field(label: str) -> FinancialField | None:
    key = _normalize_space(label).lower().strip(":.")
    return FIELD_LABELS.get(key)


def _parse_amount_token(raw: str) -> tuple[Decimal | None, CandidateIssueCode | None]:
    token = raw.strip()
    if token in {"", "-", "--", "–", "—"}:
        return None, "missing_value"
    if token.startswith("(") and token.endswith(")"):
        sign = "-"
        body = token[1:-1]
        if not body or body[0] in "+-" or any(ch.isspace() for ch in body):
            return None, "invalid_amount"
    elif token[0] in "+-":
        sign = "-" if token[0] == "-" else ""
        body = token[1:]
    else:
        sign = ""
        body = token

    if any(ch.isspace() for ch in body):
        return None, "invalid_amount"
    parts = body.split(".")
    if len(parts) > 2:
        return None, "invalid_amount"
    int_part = parts[0]
    frac_part = parts[1] if len(parts) == 2 else None
    if frac_part is not None and not re.fullmatch(r"[0-9]{1,2}", frac_part):
        return None, "invalid_amount"
    if not (
        PLAIN_INT_RE.fullmatch(int_part)
        or INTL_GROUP_RE.fullmatch(int_part)
        or INDIAN_GROUP_RE.fullmatch(int_part)
    ):
        return None, "invalid_amount"
    digits = int_part.replace(",", "")
    if len(digits) > 15:
        return None, "invalid_amount"
    clean = f"{digits}.{frac_part}" if frac_part is not None else digits
    value = Decimal(f"{sign}{clean}")
    if value == 0 and sign == "-":
        value = Decimal(clean)
    return value, None


def _parse_fiscal_years(text: str, today: date) -> tuple[list[int], bool]:
    invalid = bool(NON_MARCH_DATE_RE.search(text))
    years: list[int] = []
    for pattern in MARCH_31_PATTERNS:
        for match in pattern.finditer(text):
            year_start = int(match.group(1)) - 1
            if not (1 <= year_start <= 9998 and date(year_start + 1, 3, 31) < today):
                invalid = True
            elif year_start not in years:
                years.append(year_start)
    for match in FY_SPAN_RE.finditer(text):
        start_year = int(match.group(1))
        end_token = match.group(2)
        end_year = (start_year // 100) * 100 + int(end_token) if len(end_token) == 2 else int(end_token)
        if end_year != start_year + 1:
            invalid = True
            continue
        if not (1 <= start_year <= 9998 and date(start_year + 1, 3, 31) < today):
            invalid = True
        elif start_year not in years:
            years.append(start_year)
    return years, invalid


def _extract_pre_table_lines(page_text: str, header_row: list[str]) -> list[str]:
    joined_header = _normalize_space(" ".join(cell for cell in header_row if cell)).lower()
    first_cell = _normalize_space(header_row[0]).lower() if header_row else ""
    lines: list[str] = []
    for raw_line in page_text.splitlines():
        line = _normalize_space(raw_line)
        if not line:
            continue
        low = line.lower()
        if joined_header and low == joined_header:
            break
        if first_cell and low.startswith(first_cell + " "):
            break
        if "fictional data" in low:
            continue
        lines.append(line)
    return lines


def _resolve_page_context(
    pre_table_lines: list[str],
    header_row: list[str],
    today: date,
) -> tuple[
    str | None,
    str | None,
    str | None,
    CandidateIssueCode | None,
    str | None,
    list[int],
    bool,
    Unit | None,
    int | None,
    str | None,
    CandidateIssueCode | None,
]:
    statement_title: str | None = None
    for line in pre_table_lines:
        low = line.lower()
        if any(
            kw in low
            for kw in (
                "profit and loss",
                "income",
                "balance sheet",
                "borrowing",
                "statement",
                "financial position",
                "standalone",
                "consolidated",
            )
        ):
            statement_title = line
            break

    standalone_lines = [line for line in pre_table_lines if re.search(r"\bstandalone\b", line, re.I)]
    consolidated_lines = [line for line in pre_table_lines if re.search(r"\bconsolidated\b", line, re.I)]
    if consolidated_lines:
        basis = None
        basis_context = consolidated_lines[0]
        basis_issue: CandidateIssueCode | None = "conflicting_basis"
    elif standalone_lines:
        basis = "standalone"
        basis_context = standalone_lines[0]
        basis_issue = None
    else:
        basis = None
        basis_context = None
        basis_issue = "missing_basis"

    period_lines: list[str] = []
    context_years: list[int] = []
    context_invalid = False
    for line in pre_table_lines:
        line_years, line_invalid = _parse_fiscal_years(line, today)
        low = line.lower()
        if (
            line_years
            or line_invalid
            or any(
                kw in low
                for kw in ("year ended", "years ended", "april-march", "annual", "as at", "dates not supplied", "period")
            )
        ):
            period_lines.append(line)
            for yr in line_years:
                if yr not in context_years:
                    context_years.append(yr)
            context_invalid = context_invalid or line_invalid
    period_context = " ".join(period_lines) if period_lines else None

    matched_units: list[str] = []
    unit_lines: list[str] = []
    for line in [*pre_table_lines, *header_row]:
        line_matched = False
        for pattern, unit_name in UNIT_PATTERNS:
            for _ in pattern.finditer(line):
                matched_units.append(unit_name)
                line_matched = True
        if UNSUPPORTED_UNIT_RE.search(line):
            matched_units.append("unsupported")
            line_matched = True
        if line_matched and line not in unit_lines:
            unit_lines.append(line)

    unit_header = " ".join(unit_lines) if unit_lines else None
    distinct_units = set(matched_units)
    if not matched_units:
        unit: Unit | None = None
        multiplier: int | None = None
        unit_issue: CandidateIssueCode | None = "missing_unit"
    elif len(distinct_units) > 1 or "unsupported" in distinct_units:
        unit = None
        multiplier = None
        unit_issue = "conflicting_unit"
    else:
        resolved_unit = matched_units[0]
        assert resolved_unit in UNIT_MULTIPLIERS
        unit = resolved_unit  # type: ignore[assignment]
        multiplier = UNIT_MULTIPLIERS[resolved_unit]
        unit_issue = None

    return (
        statement_title,
        basis,
        basis_context,
        basis_issue,
        period_context,
        context_years,
        context_invalid,
        unit,
        multiplier,
        unit_header,
        unit_issue,
    )


def _is_layout_a_table(rows: list[list[str]]) -> tuple[bool, int | None, list[int]]:
    if len(rows) < 2:
        return False, None, []
    header = rows[0]
    cols = len(header)
    if not 2 <= cols <= 4 or any(len(row) != cols for row in rows):
        return False, None, []
    first = _normalize_space(header[0]).lower().strip(":.")
    if first not in LABEL_HEADERS:
        return False, None, []
    second = _normalize_space(header[1]).lower().strip(":.")
    if second in NOTE_HEADERS:
        if cols < 3:
            return False, None, []
        return True, 1, list(range(2, cols))
    if cols > 3:
        return False, None, []
    return True, None, list(range(1, cols))


def build_extraction_snapshot(
    document_sha256: str,
    extracted_char_count: int,
    raw_pages: list[tuple[int, str, list[list[list[str | None]]]]],
    *,
    today: date | None = None,
) -> DocumentExtractionSnapshot:
    if today is None:
        today = datetime.now(ZoneInfo("Asia/Kolkata")).date()

    total_text_length = 0
    total_table_rows = 0
    total_table_cells = 0
    pages: list[ExtractedPage] = []
    pending_rows: list[dict] = []
    any_layout_a = False
    document_issues: list[str] = []

    for page_number, page_text, page_raw_tables in raw_pages:
        if len(page_text) > MAX_PAGE_TEXT_LENGTH:
            raise ExtractionLimitExceeded("Page text exceeds budget")
        total_text_length += len(page_text)
        if total_text_length > MAX_TOTAL_TEXT_LENGTH:
            raise ExtractionLimitExceeded("Total document text exceeds budget")
        if len(page_raw_tables) > MAX_TABLES_PER_PAGE:
            raise ExtractionLimitExceeded("Tables per page exceed budget")

        page_tables: list[ExtractedTable] = []
        page_row_count = 0
        for table_idx, raw_table in enumerate(page_raw_tables, 1):
            if not raw_table:
                continue
            page_row_count += len(raw_table)
            total_table_rows += len(raw_table)
            if page_row_count > MAX_TABLE_ROWS_PER_PAGE or total_table_rows > MAX_TOTAL_TABLE_ROWS:
                raise ExtractionLimitExceeded("Table rows exceed budget")
            clean_rows: list[list[str]] = []
            for raw_row in raw_table:
                if not 1 <= len(raw_row) <= MAX_TABLE_COLS:
                    raise ExtractionLimitExceeded("Table columns exceed budget")
                total_table_cells += len(raw_row)
                if total_table_cells > MAX_TOTAL_TABLE_CELLS:
                    raise ExtractionLimitExceeded("Table cells exceed budget")
                clean_row: list[str] = []
                for cell in raw_row:
                    text_cell = _normalize_space(cell or "")
                    if len(text_cell) > MAX_CELL_CHARS:
                        raise ExtractionLimitExceeded("Table cell length exceeds budget")
                    clean_row.append(text_cell)
                clean_rows.append(clean_row)
            page_tables.append(ExtractedTable(table_index=table_idx, rows=clean_rows))

        page_issues: list[str] = []
        page_title: str | None = None
        page_basis: str | None = None
        page_basis_context: str | None = None
        page_period_context: str | None = None
        page_unit: Unit | None = None
        page_multiplier: int | None = None
        page_unit_header: str | None = None
        page_has_layout_a = False

        for table in page_tables:
            supported, note_col, amount_cols = _is_layout_a_table(table.rows)
            if not supported:
                continue
            page_has_layout_a = True
            any_layout_a = True
            header_row = table.rows[0]
            pre_lines = _extract_pre_table_lines(page_text, header_row)
            (
                statement_title,
                basis,
                basis_context,
                basis_issue,
                period_context,
                context_years,
                context_invalid,
                unit,
                multiplier,
                unit_header,
                unit_issue,
            ) = _resolve_page_context(pre_lines, header_row, today)

            page_title = statement_title
            page_basis = basis
            page_basis_context = basis_context
            page_period_context = period_context
            page_unit = unit
            page_multiplier = multiplier
            page_unit_header = unit_header

            col_parsed: dict[int, tuple[list[int], bool]] = {
                col: _parse_fiscal_years(header_row[col], today) for col in amount_cols
            }
            single_col_years = [
                years[0]
                for years, inv in col_parsed.values()
                if len(years) == 1 and not inv
            ]
            duplicate_col_years = {
                yr for yr in single_col_years if single_col_years.count(yr) > 1
            }

            col_resolution: dict[int, tuple[int | None, CandidateIssueCode | None]] = {}
            for col in amount_cols:
                years, col_invalid = col_parsed[col]
                if col_invalid or context_invalid or len(years) > 1:
                    col_resolution[col] = (None, "conflicting_period")
                elif not years:
                    col_resolution[col] = (None, "missing_period")
                else:
                    yr = years[0]
                    if (context_years and yr not in context_years) or yr in duplicate_col_years:
                        col_resolution[col] = (None, "conflicting_period")
                    else:
                        col_resolution[col] = (yr, None)

            source_context = [
                line
                for line in (statement_title, period_context, unit_header)
                if line is not None
            ]

            for row_idx, row in enumerate(table.rows[1:], 2):
                label = row[0]
                note = row[note_col] if note_col is not None else None
                field = _map_label_to_field(label)
                row_cells: list[dict] = []
                for col in amount_cols:
                    raw_val = row[col]
                    year_start, period_issue = col_resolution[col]
                    amount, amount_issue = _parse_amount_token(raw_val)
                    issues: list[CandidateIssueCode] = []
                    if field is None:
                        issues.append("ambiguous_mapping")
                    if basis_issue is not None:
                        issues.append(basis_issue)
                    if period_issue is not None:
                        issues.append(period_issue)
                    if unit_issue is not None:
                        issues.append(unit_issue)
                    if amount_issue is not None:
                        issues.append(amount_issue)
                    row_cells.append(
                        dict(
                            page_number=page_number,
                            table_index=table.table_index,
                            row_index=row_idx,
                            column_index=col + 1,
                            field=field,
                            label=label,
                            note=note,
                            raw=raw_val,
                            source_row=row,
                            source_context=source_context,
                            period_header=header_row[col],
                            period_context=period_context,
                            year_start=year_start,
                            unit_header=unit_header,
                            unit=unit,
                            multiplier=multiplier,
                            basis="standalone" if basis == "standalone" else None,
                            basis_context=basis_context,
                            amount=amount,
                            issues=issues,
                        )
                    )
                pending_rows.append(
                    dict(
                        page_number=page_number,
                        table_index=table.table_index,
                        field=field,
                        cells=row_cells,
                    )
                )

        if not page_has_layout_a:
            page_issues.append("unsupported_layout")

        pages.append(
            ExtractedPage(
                page_number=page_number,
                text=page_text,
                tables=page_tables,
                statement_title=page_title,
                basis="standalone" if page_basis == "standalone" else None,
                basis_context=page_basis_context,
                period_context=page_period_context,
                unit=page_unit,
                multiplier=page_multiplier,
                unit_header=page_unit_header,
                issues=page_issues,
            )
        )

    total_candidates = sum(len(item["cells"]) for item in pending_rows)
    if total_candidates > MAX_CANDIDATES:
        raise ExtractionLimitExceeded("Extracted candidates exceed budget")

    rows_by_field: dict[str, list[dict]] = {}
    for item in pending_rows:
        if item["field"] is not None:
            rows_by_field.setdefault(item["field"], []).append(item)

    for field, matched_rows in rows_by_field.items():
        if len(matched_rows) <= 1:
            continue
        years_seen: dict[int | tuple[str, int], list[tuple[Decimal | None, str]]] = {}
        same_table_groups: dict[tuple[int, int], list[dict]] = {}
        for item in matched_rows:
            same_table_groups.setdefault((item["page_number"], item["table_index"]), []).append(item)
            for idx, cell in enumerate(item["cells"]):
                key: int | tuple[str, int] = (
                    cell["year_start"] if cell["year_start"] is not None else ("col", idx)
                )
                years_seen.setdefault(key, []).append((cell["amount"], cell["raw"]))

        has_overlap = any(len(vals) > 1 for vals in years_seen.values()) or any(
            len(group) > 1 for group in same_table_groups.values()
        )
        if not has_overlap:
            continue
        has_conflict = any(
            len({(amt, raw) for amt, raw in vals}) > 1
            for vals in years_seen.values()
            if len(vals) > 1
        )
        dup_issue: CandidateIssueCode = "conflicting_match" if has_conflict else "duplicate_match"
        for item in matched_rows:
            for cell in item["cells"]:
                if dup_issue not in cell["issues"]:
                    cell["issues"].append(dup_issue)

    candidates: list[ExtractedCandidate] = []
    for item in pending_rows:
        for cell in item["cells"]:
            if not cell["issues"] and cell["amount"] is not None and cell["multiplier"] is not None:
                normalized_inr = cell["amount"] * Decimal(cell["multiplier"])
            else:
                normalized_inr = None
            candidates.append(
                ExtractedCandidate(
                    **cell,
                    normalized_inr=normalized_inr,
                    reviewed=False,
                )
            )

    if not any_layout_a:
        document_issues.append("unsupported_layout")

    return DocumentExtractionSnapshot(
        document_sha256=document_sha256,
        layout="layout_a" if any_layout_a else "unsupported",
        page_count=len(pages),
        extracted_char_count=extracted_char_count,
        pages=pages,
        candidates=candidates,
        issues=document_issues,
    )
