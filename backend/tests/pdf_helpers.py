"""Dependency-free PDF fixture writers shared by upload and corpus tests."""


def build_pdf(page_streams: list[bytes], encrypt: bool = False) -> bytes:
    objects: list[bytes] = []

    def add_obj(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font_id = add_obj(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_ids: list[int] = []
    content_ids: list[int] = []

    for stream_data in page_streams:
        content_id = add_obj(
            f"<< /Length {len(stream_data)} >>\nstream\n".encode("ascii")
            + stream_data + b"\nendstream"
        )
        content_ids.append(content_id)

    pages_placeholder_idx = len(objects)
    objects.append(b"")  # placeholder for /Pages object
    pages_id = pages_placeholder_idx + 1

    for content_id in content_ids:
        page_id = add_obj(
            f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
            f"/Contents {content_id} 0 R >>".encode("ascii")
        )
        page_ids.append(page_id)

    kids_str = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects[pages_placeholder_idx] = (
        f"<< /Type /Pages /Kids [{kids_str}] /Count {len(page_ids)} >>".encode("ascii")
    )
    catalog_id = add_obj(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode("ascii"))

    encrypt_id = None
    if encrypt:
        encrypt_id = add_obj(
            b"<< /Filter /Standard /V 1 /R 2 /Length 40 "
            b"/P -4 /O (0123456789abcdef0123456789abcdef) "
            b"/U (0123456789abcdef0123456789abcdef) >>"
        )

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for idx, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out.extend(f"{idx} 0 obj\n".encode("ascii"))
        out.extend(body)
        out.extend(b"\nendobj\n")

    xref_offset = len(out)
    out.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    out.extend(b"0000000000 65535 f \n")
    for off in offsets:
        out.extend(f"{off:010d} 00000 n \n".encode("ascii"))

    trailer = f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R"
    if encrypt_id is not None:
        trailer += f" /Encrypt {encrypt_id} 0 R"
    trailer += f" >>\nstartxref\n{xref_offset}\n%%EOF\n"
    out.extend(trailer.encode("ascii"))
    return bytes(out)


def build_minimal_pdf(pages_text: list[str], encrypt: bool = False) -> bytes:
    """Construct a valid minimal PDF with selectable text or blank pages."""
    streams = []
    for text in pages_text:
        if text:
            escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode("latin-1")
            streams.append(b"BT /F1 12 Tf 72 720 Td (" + escaped + b") Tj ET")
        else:
            streams.append(b"")
    return build_pdf(streams, encrypt=encrypt)


def inspect_pdf_bytes(data: bytes):
    import io
    import tempfile
    from pathlib import Path

    from app.pdf_processing import inspect_pdf_file, read_bounded_upload

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "input.pdf"
        path.write_bytes(read_bounded_upload(io.BytesIO(data), "application/pdf"))
        return inspect_pdf_file(path)
