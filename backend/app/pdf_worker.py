"""One bounded local PDF inspection, with a small JSON-only output protocol."""
import json
import logging
import sys

from app.pdf_limits import (MAX_DECODED_BYTES, MAX_PDF_BYTES, MAX_PDF_PAGES,
                            MAX_STREAM_BYTES, MAX_TEXT_CHARS, set_process_limits)


class Rejected(Exception):
    pass


def inspect(path: str) -> tuple[int, int]:
    import pdfplumber
    from pdfminer.pdfpage import PDFPage
    from pdfminer.pdftypes import resolve1
    from pdfplumber.page import Page

    with open(path, "rb") as source:
        if len(source.read(MAX_PDF_BYTES + 1)) > MAX_PDF_BYTES:
            raise Rejected("file_too_large")
    pdf = pdfplumber.open(path)
    try:
        if pdf.doc.encryption is not None:
            raise Rejected("encrypted_pdf")
        pages = chars = decoded_bytes = 0
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
                chars += sum(not char.isspace() for char in (page.extract_text() or ""))
                if chars > MAX_TEXT_CHARS:
                    raise Rejected("parser_resource_limit")
            finally:
                page.close()
            pages = number
        if not pages:
            raise Rejected("empty_pdf_pages")
        if not chars:
            raise Rejected("scanned_only_pdf")
        return pages, chars
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
        pages, chars = inspect(sys.argv[1])
        result = {"pages": pages, "chars": chars}
    except Rejected as exc:
        result = {"error": str(exc)}
    except MemoryError:
        result = {"error": "parser_resource_limit"}
    except Exception as exc:
        from pdfminer.pdfdocument import PDFEncryptionError, PDFPasswordIncorrect
        cause = exc.args[0] if exc.args and isinstance(exc.args[0], Exception) else exc
        result = {"error": "encrypted_pdf" if isinstance(cause, (PDFPasswordIncorrect, PDFEncryptionError)) else "corrupted_pdf"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
