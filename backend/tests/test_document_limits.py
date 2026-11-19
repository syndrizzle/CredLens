import asyncio
import os
import subprocess
import sys
import zlib
from unittest.mock import Mock

import pytest

from app import document_ingress, documents, pdf_limits, pdf_worker
from pdf_helpers import build_minimal_pdf


def test_page_iteration_stops_before_page_51(tmp_path, monkeypatch):
    from pdfplumber import page
    path = tmp_path / "many.pdf"
    path.write_bytes(build_minimal_pdf(["Revenue"] * 1000))
    created = 0
    original = page.Page
    def count(*args, **kwargs):
        nonlocal created
        created += 1
        return original(*args, **kwargs)
    monkeypatch.setattr(page, "Page", count)
    with pytest.raises(pdf_worker.Rejected, match="too_many_pages"):
        pdf_worker.inspect(str(path))
    assert created == 50


def test_compressed_stream_is_bounded():
    data = build_minimal_pdf(["Revenue"])
    start = data.index(b"stream\n") + len(b"stream\n")
    end = data.index(b"\nendstream", start)
    compressed = zlib.compress(b" " * (32 * 1024 * 1024) + data[start:end])
    # pdfminer reconstructs cross-references after the stream length changes.
    data = data[:start].replace(b"/Length ", b"/Filter /FlateDecode /Length ") + compressed + data[end:]
    with pytest.raises(documents.DocumentRejectError) as exc:
        documents.inspect_pdf_bytes(data)
    assert exc.value.code == "parser_resource_limit"


def test_timeout_kills_child_and_reports_failure(tmp_path, monkeypatch):
    original = subprocess.run
    child = None
    def run(*args, **kwargs):
        nonlocal child
        script = "import os,time;open('child.pid','w').write(str(os.getpid()));time.sleep(60)"
        kwargs.update(timeout=0.25, cwd=tmp_path)
        try:
            return original([sys.executable, "-c", script], **kwargs)
        finally:
            child = int((tmp_path / "child.pid").read_text())
    monkeypatch.setattr(documents.subprocess, "run", run)
    with pytest.raises(documents.DocumentRejectError) as exc:
        documents.inspect_pdf_file(tmp_path / "input.pdf")
    assert exc.value.code == "parser_timeout"
    if os.name != "nt":
        with pytest.raises(ProcessLookupError):
            os.kill(child, 0)


def test_os_memory_budget_and_fail_closed(monkeypatch, capsys):
    result = subprocess.run([sys.executable, "-c", "from app.pdf_limits import *;set_process_limits();print('LIMITS_INSTALLED',flush=True);data=bytearray(MEMORY_BYTES)"], capture_output=True, timeout=5)
    assert b"LIMITS_INSTALLED" in result.stdout and result.returncode != 0
    monkeypatch.setattr(pdf_worker, "set_process_limits", Mock(side_effect=OSError))
    monkeypatch.setattr(pdf_worker, "inspect", Mock(side_effect=AssertionError("parser must not start")))
    pdf_worker.main()
    pdf_worker.inspect.assert_not_called()
    assert "parser_limits_unavailable" in capsys.readouterr().out


def test_windows_job_limits_protocol(monkeypatch):
    import ctypes
    kernel = Mock()
    kernel.CreateJobObjectW.return_value = 1
    captured = []
    def configure(handle, kind, pointer, size):
        limits = pointer._obj
        captured.append((handle, kind, size, limits.basic.flags, limits.basic.process_time, limits.process_memory))
        return 1
    kernel.SetInformationJobObject.side_effect = configure
    monkeypatch.setattr(ctypes, "WinDLL", Mock(return_value=kernel), raising=False)
    pdf_limits._set_windows_limits()
    assert captured[0][1] == 9
    assert captured[0][3:] == (0x102, pdf_limits.CPU_SECONDS * 10_000_000, pdf_limits.MEMORY_BYTES)
    kernel.AssignProcessToJobObject.assert_called_once()
    kernel.AssignProcessToJobObject.return_value = 0
    with pytest.raises(OSError):
        pdf_limits._set_windows_limits()
    kernel.CloseHandle.assert_called_once_with(1)


def run_guard(headers, chunks, monkeypatch, *, authorized=True):
    calls, sent, app_bodies = [], [], []
    def authorize(token):
        if not authorized:
            raise PermissionError
    monkeypatch.setattr(document_ingress, "authorize_upload", authorize)
    monkeypatch.setattr(document_ingress, "MAX_UPLOAD_REQUEST_BYTES", 1024)
    async def receive():
        calls.append(1)
        if chunks:
            chunk = chunks.pop(0)
            return {"type": "http.request", "body": chunk, "more_body": bool(chunks)}
        return {"type": "http.disconnect"}
    async def send(message):
        sent.append(message)
    async def app(scope, receive, send):
        while True:
            message = await receive()
            app_bodies.append(message.get("body", b""))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})
    scope = {"type": "http", "method": "POST", "path": "/api/businesses/example/documents", "headers": headers}
    asyncio.run(document_ingress.DocumentUploadGuard(app)(scope, receive, send))
    return sent[0]["status"], len(calls), b"".join(app_bodies)


def test_ingress_authenticates_before_reading_and_bounds_chunked_body(monkeypatch):
    assert run_guard([], [b"x" * 2048], monkeypatch, authorized=False) == (401, 0, b"")
    assert run_guard([(b"content-length", b"2048")], [b"x" * 2048], monkeypatch) == (413, 0, b"")
    assert run_guard([], [b"x" * 600, b"x" * 600, b"x"], monkeypatch) == (413, 2, b"")
    assert run_guard([], [b"x" * 512, b"y" * 512], monkeypatch) == (204, 2, b"x" * 512 + b"y" * 512)
    assert run_guard([], [b""], monkeypatch) == (204, 1, b"")
    assert run_guard([(b"content-length", b"-1")], [b""], monkeypatch)[0] == 400


def test_actual_route_rejects_anonymous_upload_before_multipart(monkeypatch):
    from fastapi.testclient import TestClient
    from starlette.formparsers import MultiPartParser
    from app.main import app
    parser = Mock(side_effect=AssertionError("multipart must not run"))
    monkeypatch.setattr(MultiPartParser, "parse", parser)
    response = TestClient(app).post("/api/businesses/00000000-0000-0000-0000-000000000000/documents", content=b"x" * (21 * 1024 * 1024), headers={"content-type": "multipart/form-data; boundary=test"})
    assert response.status_code == 401
    parser.assert_not_called()


def test_atomic_storage_is_private_before_publication(tmp_path, monkeypatch):
    import stat
    target = tmp_path / "existing-business" / "source.pdf"
    target.parent.mkdir(mode=0o755)
    original = os.replace
    def publish(source, destination):
        if os.name != "nt":
            assert stat.S_IMODE(source.stat().st_mode) == 0o600
        assert source.read_bytes() == b"%PDF-test"
        original(source, destination)
    monkeypatch.setattr(os, "replace", publish)
    documents._write_pdf_atomically(target, b"%PDF-test")
    assert target.read_bytes() == b"%PDF-test"
    assert not target.with_suffix(".tmp").exists()
