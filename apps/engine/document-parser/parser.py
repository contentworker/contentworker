"""Produce the text, static preview and media manifest for one local document page."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

from keynote import conversion_package
from range_source import signed_object
from presentation import slides, read_slide, single_slide_package

CONVERSION_LIMIT = 256 * 1024 * 1024


def run(*args, home):
    return subprocess.run(args, cwd=home, env={**os.environ, "HOME": str(home), "LC_ALL": "C"},
                          stdin=subprocess.DEVNULL, capture_output=True, timeout=180,
                          check=True).stdout.decode("utf-8", errors="replace")


class PageWriter(io.BufferedWriter):
    def write(self, data):
        if self.tell() + len(data) > CONVERSION_LIMIT:
            raise ValueError("PDF page exceeds the conversion budget")
        return super().write(data)


def copy_pdf_page(source, number, destination):
    import pikepdf
    # Recovery can scan the entire file. Require valid cross-references for ranged input.
    with pikepdf.Pdf.open(source, attempt_recovery=False) as original, pikepdf.Pdf.new() as page:
        count = len(original.pages)
        if not 1 <= number <= count:
            raise ValueError("Page outside document")
        page.pages.append(original.pages[number - 1])
        with PageWriter(io.FileIO(destination, "w")) as out:
            page.save(out)
        return count


def render(pdf, number, output, scratch):
    info = run("pdfinfo", pdf, home=scratch)
    count = int(re.search(r"^Pages:\s+(\d+)", info, re.M)[1])
    if not 1 <= number <= count:
        raise ValueError("Page outside document")
    page = str(number)
    prefix = output / "preview"
    run("pdftoppm", "-f", page, "-l", page, "-singlefile", "-scale-to", "1440",
        "-png", pdf, prefix, home=scratch)
    text = run("pdftotext", "-f", page, "-l", page, "-enc", "UTF-8", pdf, "-", home=scratch).strip()
    method = "native"
    if not text:
        text = run("tesseract", prefix.with_suffix(".png"), "stdout", home=scratch).strip()
        method = "ocr"
    return count, text, method


def store_media(stream, output):
    digest = hashlib.sha256()
    with tempfile.NamedTemporaryFile(dir=output, delete=False) as tmp:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            tmp.write(chunk)
    name = digest.hexdigest()
    os.replace(tmp.name, output / name)
    return name


def process(source, number, output, scratch, ranged_source=None):
    if number < 1:
        raise ValueError("Page numbers start at one")
    suffix = source.suffix.lower()
    if suffix not in {".pdf", ".pptx", ".key"}:
        raise ValueError("Unsupported document type")
    output.mkdir()
    media = []
    warnings = []
    native = None
    count = None
    deck = source
    if suffix == ".key":
        conversion_input = source
        if ranged_source is not None or source.stat().st_size > CONVERSION_LIMIT:
            conversion_input = scratch / "bounded.key"
            with zipfile.ZipFile(ranged_source if ranged_source is not None else source) as archive:
                omitted = conversion_package(archive, conversion_input, CONVERSION_LIMIT)
            if omitted:
                warnings.append(f"Keynote conversion omitted {omitted} media parts over its budget")
        run("soffice", "--headless", "--convert-to", "pptx", "--outdir", scratch,
            conversion_input, home=scratch)
        deck = scratch / (conversion_input.stem + ".pptx")
    if deck.suffix.lower() == ".pptx":
        deck_input = ranged_source if suffix == ".pptx" and ranged_source is not None else deck
        with zipfile.ZipFile(deck_input) as archive:
            ordered = slides(archive)
            count = len(ordered)
            if number > count:
                raise ValueError("Slide outside document")
            native, refs = read_slide(archive, ordered[number - 1])
            converted = scratch / "one-slide.pptx"
            try:
                warnings.extend(single_slide_package(archive, ordered[number - 1], converted,
                                                     CONVERSION_LIMIT))
            except ValueError as exc:
                warnings.append(str(exc))
                converted = None
            for target, info in refs.items():
                if info.file_size > CONVERSION_LIMIT:
                    warnings.append(f"Media exceeds local extraction limit: {target}")
                    continue
                with archive.open(info) as member:
                    media.append({"part": target, "sha256": store_media(member, output)})
    pdf = source
    render_number = number if suffix == ".pdf" else 1
    if suffix == ".pdf" and ranged_source is not None:
        pdf = scratch / "one-page.pdf"
        count = copy_pdf_page(ranged_source, number, pdf)
        render_number = 1
    preview = None
    text = native or ""
    method = "native"
    if suffix == ".pdf" or converted:
        if suffix != ".pdf":
            run("soffice", "--headless", "--convert-to", "pdf", "--outdir", scratch,
                converted, home=scratch)
            pdf = scratch / "one-slide.pdf"
        pdf_count, rendered, method = render(pdf, render_number, output, scratch)
        if count is None:
            count = pdf_count
        preview = "preview.png"
        if native:
            method = "native"
        text = native or rendered
        if suffix == ".pdf":
            run("pdfimages", "-f", str(render_number), "-l", str(render_number), "-all", pdf,
                scratch / "image", home=scratch)
            for path in sorted(scratch.glob("image-*")):
                with path.open("rb") as member:
                    media.append({"part": path.name, "sha256": store_media(member, output)})

    return {"page": number, "pages": count, "text": text, "textMethod": method,
            "preview": preview, "media": media, "warnings": warnings,
            "status": "partial" if warnings else "complete"}


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("source", type=Path)
    cli.add_argument("page", type=int)
    cli.add_argument("output", type=Path)
    cli.add_argument("--r2-object", "--r2-package", "--r2-pptx", action="store_true",
                     help="Read a PDF, packaged Keynote or PPTX from DOCUMENT_SOURCE_URL using pinned byte ranges")
    cli.add_argument("--size", type=int)
    cli.add_argument("--etag")
    args = cli.parse_args()
    ranged_source = None
    if args.r2_object:
        if args.source.suffix.lower() not in {".pdf", ".pptx", ".key"} or not args.size or not args.etag:
            cli.error("Range mode requires a supported filename, --size and --etag")
        ranged_source = signed_object(os.environ["DOCUMENT_SOURCE_URL"], args.size, args.etag)
    with tempfile.TemporaryDirectory() as work:
        tmp = Path(work)
        manifest = process(args.source.resolve(), args.page, tmp / "result", tmp, ranged_source)
        (tmp / "result" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False))
        shutil.copytree(tmp / "result", args.output)
