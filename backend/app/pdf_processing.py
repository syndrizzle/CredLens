"""Bound PDF uploads and run the isolated PDF worker."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import BinaryIO

from app.pdf_limits import MAX_PDF_BYTES, MAX_WORKER_STDOUT_BYTES, WALL_SECONDS
from app.schemas.documents import DocumentExtractionSnapshot

READ_CHUNK_BYTES = 64 * 1024
ALLOWED_CONTENT_TYPES = {
    "",
    "application/pdf",
    "application/x-pdf",
    "application/octet-stream",
    "binary/octet-stream",
}
PDF_ERRORS = {
    "encrypted_pdf": "Password-protected or encrypted PDFs are not supported.",
    "corrupted_pdf": "PDF could not be parsed. Check the file and upload it again.",
    "empty_pdf_pages": "PDF contains no readable pages.",
    "too_many_pages": "PDF exceeds the 50-page limit.",
    "scanned_only_pdf": "Scanned or image-only PDFs without selectable digital text are not supported.",
    "parser_resource_limit": "PDF exceeds the parser resource budget. Use a smaller PDF or manual entry.",
    "parser_timeout": "PDF processing timed out. Use a smaller PDF or retry processing.",
    "parser_limits_unavailable": "Parser resource limits could not be installed on this host.",
    "parser_unavailable": "PDF processing is unavailable. Check the local backend and retry.",
    "file_too_large": "PDF exceeds the 20 MB maximum file size limit.",
}


class DocumentRejectError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code, self.code, self.message = status_code, code, message


def sanitize_pdf_filename(filename: str | None) -> str:
    raw = (filename or "").strip()
    base = Path(raw.replace("\\", "/")).name.strip()
    base = re.sub(r"[\x00-\x1f\x7f]+", "", base)
    if not base or not base.lower().endswith(".pdf") or len(base) <= 4:
        raise DocumentRejectError(
            415,
            "unsupported_file_type",
            "Only PDF files (.pdf) are supported.",
        )
    if len(base) > 255:
        stem = base[:-4][:251].rstrip()
        base = f"{stem}.pdf"
    return base


def read_bounded_upload(stream: BinaryIO, content_type: str | None) -> bytes:
    normalized_type = (content_type or "").split(";")[0].strip().lower()
    if normalized_type not in ALLOWED_CONTENT_TYPES:
        raise DocumentRejectError(
            415,
            "unsupported_media_type",
            "Unsupported content type. Upload a digital PDF file (application/pdf).",
        )
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = stream.read(READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_PDF_BYTES:
            raise DocumentRejectError(
                413,
                "file_too_large",
                "PDF exceeds the 20 MB maximum file size limit.",
            )
        chunks.append(chunk)
    if total == 0:
        raise DocumentRejectError(
            400,
            "empty_file",
            "Uploaded PDF file is empty.",
        )
    data = b"".join(chunks)
    header_window = data[:1024]
    pdf_pos = header_window.find(b"%PDF-")
    if pdf_pos == -1 or (pdf_pos > 0 and header_window[:pdf_pos].strip()):
        raise DocumentRejectError(
            415,
            "invalid_pdf_header",
            "File does not have a valid PDF header.",
        )
    return data


def inspect_pdf_file(path: Path) -> DocumentExtractionSnapshot:
    env = {
        key: value
        for key, value in os.environ.items()
        if key in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"}
    }
    try:
        result = subprocess.run(
            [sys.executable, "-m", "app.pdf_worker", str(path)],
            cwd=Path(__file__).resolve().parents[1],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=WALL_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise DocumentRejectError(
            422, "parser_timeout", PDF_ERRORS["parser_timeout"]
        ) from None
    except OSError:
        raise DocumentRejectError(
            503, "parser_unavailable", PDF_ERRORS["parser_unavailable"]
        ) from None
    if result.returncode or len(result.stdout) > MAX_WORKER_STDOUT_BYTES:
        raise DocumentRejectError(
            422, "parser_resource_limit", PDF_ERRORS["parser_resource_limit"]
        )
    try:
        body = json.loads(result.stdout)
        if not isinstance(body, dict):
            raise ValueError
        if "error" in body:
            code = body["error"]
            if code not in PDF_ERRORS:
                raise ValueError
            raise DocumentRejectError(422, code, PDF_ERRORS[code])
        return DocumentExtractionSnapshot.model_validate(body["extraction"])
    except DocumentRejectError:
        raise
    except (ValueError, KeyError, TypeError):
        raise DocumentRejectError(
            503, "parser_unavailable", PDF_ERRORS["parser_unavailable"]
        ) from None
