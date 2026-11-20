"""One bounded local PDF inspection and candidate extraction worker."""
import hashlib
import json
import logging
import sys

from app.pdf_limits import (
    MAX_DECODED_BYTES,
    MAX_PAGE_TEXT_LENGTH,
    MAX_PDF_BYTES,
    MAX_PDF_PAGES,
    MAX_STREAM_BYTES,
    MAX_TABLES_PER_PAGE,
    MAX_TEXT_CHARS,
    MAX_TOTAL_TEXT_LENGTH,
    MAX_WORKER_STDOUT_BYTES,
    set_process_limits,
)


class Rejected(Exception):
    pass


class PdfInspectionResult(tuple):
    pages: int
    chars: int
    extraction: dict

    def __new__(cls, pages: int, chars: int, extraction: dict):
        obj = super().__new__(cls, (pages, chars))
        obj.pages = pages
        obj.chars = chars
        obj.extraction = extraction
        return obj


def inspect(path: str) -> PdfInspectionResult:
    import pdfplumber
    from pdfminer.pdfpage import PDFPage
    from pdfminer.pdftypes import resolve1
    from pdfplumber.page import Page

    from app.pdf_extraction import ExtractionLimitExceeded, build_extraction_snapshot

    digest = hashlib.sha256()
    total_bytes = 0
    with open(path, "rb") as source:
        while chunk := source.read(64 * 1024):
            total_bytes += len(chunk)
            if total_bytes > MAX_PDF_BYTES:
                raise Rejected("file_too_large")
            digest.update(chunk)
    document_sha256 = digest.hexdigest()

    pdf = pdfplumber.open(path)
    try:
        if pdf.doc.encryption is not None:
            raise Rejected("encrypted_pdf")
        pages = chars = decoded_bytes = total_text_len = 0
        raw_pages: list[tuple[int, str, list[list[list[str | None]]]]] = []
        table_contexts = {}
        for number, raw_page in enumerate(PDFPage.create_pages(pdf.doc), 1):
            if number > MAX_PDF_PAGES:
                raise Rejected("too_many_pages")
            for content in raw_page.contents:
                stream = resolve1(content).get_data()
                decoded_bytes += len(stream)
                if len(stream) > MAX_STREAM_BYTES or decoded_bytes > MAX_DECODED_BYTES:
                    raise Rejected("parser_resource_limit")
            page = Page(pdf, raw_page, page_number=number)
            try:
                page_text = page.extract_text() or ""
                if len(page_text) > MAX_PAGE_TEXT_LENGTH:
                    raise Rejected("parser_resource_limit")
                total_text_len += len(page_text)
                if total_text_len > MAX_TOTAL_TEXT_LENGTH:
                    raise Rejected("parser_resource_limit")
                chars += sum(not char.isspace() for char in page_text)
                if chars > MAX_TEXT_CHARS:
                    raise Rejected("parser_resource_limit")
                found = sorted(page.find_tables(), key=lambda table: table.bbox[1])
                if len(found) > MAX_TABLES_PER_PAGE:
                    raise Rejected("parser_resource_limit")
                tables = [table.extract() for table in found]
                # Only vertically separated tables have unambiguous heading bands.
                previous_bottom = page.bbox[1]
                for index, table in enumerate(found, 1):
                    _, top, _, bottom = table.bbox
                    left, _, right, _ = page.bbox
                    heading = footer = ""
                    overlaps_next = index < len(found) and found[index].bbox[1] < bottom
                    if previous_bottom < top and not overlaps_next:
                        heading = page.within_bbox((left, previous_bottom, right, top)).extract_text()
                        if len(found) == 1 and bottom < page.bbox[3]:
                            footer = page.within_bbox((left, bottom, right, page.bbox[3])).extract_text()
                    table_contexts[number, index] = heading, footer
                    previous_bottom = max(previous_bottom, bottom)
                raw_pages.append((number, page_text, tables))
            finally:
                page.close()
            pages = number
        if not pages:
            raise Rejected("empty_pdf_pages")
        if not chars:
            raise Rejected("scanned_only_pdf")
        try:
            snapshot = build_extraction_snapshot(document_sha256, chars, raw_pages, table_contexts=table_contexts)
        except ExtractionLimitExceeded:
            raise Rejected("parser_resource_limit") from None
        return PdfInspectionResult(pages, chars, snapshot.model_dump(mode="json"))
    finally:
        # PDF.close() eagerly reconstructs pdf.pages, bypassing the bounded page iterator.
        pdf.stream.close()


def main() -> None:
    logging.disable(logging.CRITICAL)
    try:
        set_process_limits()
    except Exception:
        print(json.dumps({"error": "parser_limits_unavailable"}))
        return
    try:
        inspected = inspect(sys.argv[1])
        result: dict = {
            "pages": inspected.pages,
            "chars": inspected.chars,
            "extraction": inspected.extraction,
        }
    except Rejected as exc:
        result = {"error": str(exc)}
    except MemoryError:
        result = {"error": "parser_resource_limit"}
    except Exception as exc:
        from pdfminer.pdfdocument import PDFEncryptionError, PDFPasswordIncorrect

        cause = exc.args[0] if exc.args and isinstance(exc.args[0], Exception) else exc
        result = {
            "error": "encrypted_pdf"
            if isinstance(cause, (PDFPasswordIncorrect, PDFEncryptionError))
            else "corrupted_pdf"
        }
    serialized = json.dumps(result)
    if len(serialized.encode("utf-8")) > MAX_WORKER_STDOUT_BYTES:
        serialized = json.dumps({"error": "parser_resource_limit"})
    print(serialized)


if __name__ == "__main__":
    main()
