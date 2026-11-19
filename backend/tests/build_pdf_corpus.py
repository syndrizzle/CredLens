"""Reproduce frozen source PDFs without running an extractor or adding dependencies."""
import hashlib
import json
from pathlib import Path

from pdf_helpers import build_pdf

CORPUS = Path(__file__).parent / "fixtures" / "pdf_corpus"


def text(x: int, y: int, value: str, size: int = 10) -> str:
    escaped = value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"BT /F1 {size} Tf {x} {y} Td ({escaped}) Tj ET\n"


def render_document(document: dict) -> bytes:
    streams = []
    for number, page in enumerate(document["pages"], 1):
        held_out = document["split"] == "held_out"
        left, top, height = (42, 592, 38) if held_out else (36, 610, 32)
        # Layout B deliberately changes spacing, row order, and column order.
        edges = [left, 375, 410, 490, 576]
        commands = text(left, 750, "FICTIONAL DATA - not real financial statements", 11)
        commands += text(left, 720, document["business"], 14)
        commands += text(left, 694, page["title"], 12)
        for offset, header in enumerate(page["context"]):
            commands += text(left, 672 - offset * 16, header)
        rows = [page["headers"]] + [
            [row["label"], row["note"]] + [cell["raw"] for cell in row["values"]]
            for row in page["rows"]
        ]
        bottom = top - len(rows) * height
        commands += "0.5 w\n"
        for x in edges:
            commands += f"{x} {bottom} m {x} {top} l S\n"
        for index in range(len(rows) + 1):
            y = top - index * height
            commands += f"{left} {y} m 576 {y} l S\n"
        for index, row in enumerate(rows):
            y = top - index * height - 20
            for column, value in enumerate(row):
                if column < 2:
                    commands += text(edges[column] + 5, y, value, 9)
                else:
                    # Helvetica digits and punctuation used by tokens are at most 6pt wide.
                    commands += text(edges[column + 1] - 5 - len(value) * 5, y, value, 9)
        commands += text(left, 64, "Borrowings exclude leases; short-term excludes current maturities.", 9)
        commands += text(left, 46, "Prepared for CredLens software tests only. No authenticity or lending claim.", 9)
        commands += text(525, 26, f"Page {number}", 9)
        streams.append(commands.encode("ascii"))
    return build_pdf(streams)


def main() -> None:
    manifest = json.loads((CORPUS / "manifest.json").read_text())
    for document in manifest["documents"]:
        data = render_document(document)
        target = CORPUS / document["file"]
        if hashlib.sha256(data).hexdigest() != document["sha256"]:
            raise ValueError(f"Frozen PDF changed: {target.name}; do not re-freeze silently")
        target.write_bytes(data)
    print(f"Reproduced {len(manifest['documents'])} frozen PDFs; all hashes match.")


if __name__ == "__main__":
    main()
