from __future__ import annotations

import io
import os
import re
import zipfile
import xml.etree.ElementTree as ET

MAX_FILE_BYTES = 10 * 1024 * 1024  # 10MB per file

_TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".rst", ".json", ".yaml", ".yml", ".csv", ".tsv",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".rb", ".php", ".sql",
    ".html", ".htm", ".css", ".scss", ".xml", ".toml", ".ini", ".cfg", ".log",
}


class DocumentIngestionError(ValueError):
    pass


def _normalize_whitespace(text: str) -> str:
    lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.splitlines()]
    compact = "\n".join([ln for ln in lines if ln])
    return compact.strip()


def _extract_text_from_pdf(file_bytes: bytes) -> str:
    try:
        from pypdf import PdfReader
    except Exception as exc:
        raise DocumentIngestionError("PDF support requires pypdf to be installed") from exc

    reader = PdfReader(io.BytesIO(file_bytes))
    pages: list[str] = []
    for page in reader.pages:
        pages.append(page.extract_text() or "")
    text = "\n\n".join(pages)
    return _normalize_whitespace(text)


def _extract_text_from_text_file(file_bytes: bytes) -> str:
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return _normalize_whitespace(file_bytes.decode(enc))
        except UnicodeDecodeError:
            continue
    raise DocumentIngestionError("Unable to decode text file")


def _extract_text_from_docx(file_bytes: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            xml_bytes = zf.read("word/document.xml")
        root = ET.fromstring(xml_bytes)
    except Exception as exc:
        raise DocumentIngestionError("Unable to parse DOCX file") from exc

    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    texts = [node.text for node in root.findall(".//w:t", ns) if node.text]
    return _normalize_whitespace(" ".join(texts))


def extract_document_text(filename: str, content_type: str | None, file_bytes: bytes) -> str:
    if not filename:
        raise DocumentIngestionError("Filename is required")
    if len(file_bytes) == 0:
        raise DocumentIngestionError("File is empty")
    if len(file_bytes) > MAX_FILE_BYTES:
        raise DocumentIngestionError("File is too large (max 10MB)")

    ext = os.path.splitext(filename.lower())[1]
    ctype = (content_type or "").lower()

    if ext == ".pdf" or ctype == "application/pdf":
        text = _extract_text_from_pdf(file_bytes)
    elif ext == ".docx" or ctype == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        text = _extract_text_from_docx(file_bytes)
    elif ext in _TEXT_EXTENSIONS or ctype.startswith("text/"):
        text = _extract_text_from_text_file(file_bytes)
    else:
        raise DocumentIngestionError(
            "Unsupported file type. Use PDF, DOCX, or text-based files (txt, md, json, csv, code, etc.)."
        )

    if not text:
        raise DocumentIngestionError("No readable text found in file")
    return text


def split_text_into_chunks(text: str, chunk_size: int = 1800, overlap: int = 250) -> list[str]:
    normalized = _normalize_whitespace(text)
    if not normalized:
        return []

    paragraphs = [p.strip() for p in normalized.split("\n\n") if p.strip()]
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        candidate = f"{current}\n\n{para}".strip() if current else para
        if len(candidate) <= chunk_size:
            current = candidate
            continue

        if current:
            chunks.append(current)

        if len(para) <= chunk_size:
            current = para
            continue

        # Long paragraph fallback: split by character window with overlap.
        start = 0
        step = max(chunk_size - overlap, 200)
        while start < len(para):
            end = min(start + chunk_size, len(para))
            chunks.append(para[start:end].strip())
            if end >= len(para):
                break
            start += step
        current = ""

    if current:
        chunks.append(current)

    return [c for c in chunks if c]
