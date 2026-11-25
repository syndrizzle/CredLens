"""Authenticate and bound PDF request bodies before FastAPI parses multipart data."""
import tempfile

from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import compile_path
from starlette.types import ASGIApp, Receive, Scope, Send

from app.auth import SESSION_COOKIE, resolve_session
from app.database import get_engine
from app.pdf_limits import MAX_PDF_BYTES

DOCUMENT_UPLOAD_PATH = "/api/businesses/{business_id}/documents"
_UPLOAD_PATH = compile_path(DOCUMENT_UPLOAD_PATH)[0]
MAX_UPLOAD_REQUEST_BYTES = MAX_PDF_BYTES + 64 * 1024


def authorize_upload(token: str | None) -> None:
    if not token:
        raise PermissionError("Authentication required")
    with get_engine().connect() as connection:
        resolve_session(connection, token)


class DocumentUploadGuard:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("method") != "POST"
            or not _UPLOAD_PATH.fullmatch(scope.get("path", "").rstrip("/"))
        ):
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        try:
            await run_in_threadpool(authorize_upload, request.cookies.get(SESSION_COOKIE))
        except PermissionError:
            await JSONResponse({"detail": "Authentication required"}, status_code=401)(scope, receive, send)
            return
        except (RuntimeError, SQLAlchemyError):
            await JSONResponse({"detail": "Database unavailable"}, status_code=503)(scope, receive, send)
            return
        too_large = JSONResponse({"detail": {"code": "file_too_large", "message": "PDF request exceeds the upload size limit (20 MB file plus bounded multipart headers)."}}, status_code=413)
        length = request.headers.get("content-length")
        if length is not None:
            try:
                if int(length) < 0:
                    raise ValueError
                if int(length) > MAX_UPLOAD_REQUEST_BYTES:
                    await too_large(scope, receive, send)
                    return
            except ValueError:
                await JSONResponse({"detail": "Invalid Content-Length"}, status_code=400)(scope, receive, send)
                return
        # The guard owns this bounded spool, so errors cannot leak a multipart parser's temp files.
        with tempfile.SpooledTemporaryFile(max_size=1024 * 1024) as body:
            total = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                total += len(chunk)
                if total > MAX_UPLOAD_REQUEST_BYTES:
                    await too_large(scope, receive, send)
                    return
                await run_in_threadpool(body.write, chunk)
                if not message.get("more_body", False):
                    break
            await run_in_threadpool(body.seek, 0)
            remaining = total
            finished = False

            async def bounded_receive():
                nonlocal remaining, finished
                if finished:
                    return await receive()
                chunk = await run_in_threadpool(body.read, min(64 * 1024, remaining))
                remaining -= len(chunk)
                finished = remaining == 0
                return {"type": "http.request", "body": chunk, "more_body": remaining > 0}

            await self.app(scope, bounded_receive, send)
