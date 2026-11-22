from importlib.util import find_spec
from pathlib import Path
import tempfile
import unittest

from parser import process
from range_source import RangeSource


def sparse_pdf(file):
    """Two pages with an unreferenced 1 TB stream before the final page content."""
    file.write(b"%PDF-1.7\n")
    offsets = [0]
    def obj(data):
        offsets.append(file.tell())
        file.write(f"{len(offsets) - 1} 0 obj\n".encode() + data + b"\nendobj\n")
    def text(value):
        data = f"BT /F 14 Tf 20 100 Td ({value}) Tj ET".encode()
        return f"<< /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream"
    obj(b"<< /Type /Catalog /Pages 2 0 R >>")
    obj(b"<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>")
    for content in (6, 8):
        obj(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents {content} 0 R "
            "/Resources << /Font << /F 5 0 R >> >> >>".encode())
    obj(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    obj(text("First page"))
    offsets.append(file.tell())
    pad = 1_000_000_000_000 - 1024
    file.write(f"7 0 obj\n<< /Length {pad} >>\nstream\n".encode())
    file.seek(pad, 1)
    file.write(b"\nendstream\nendobj\n")
    obj(text("Final page"))
    xref = file.tell()
    entries = b"\0" * 6 + b"\xff\xff" + b"".join(
        b"\x01" + i.to_bytes(5, "big") + b"\0\0" for i in offsets[1:] + [xref])
    obj(f"<< /Type /XRef /Root 1 0 R /Size 10 /W [1 5 2] /Length {len(entries)} >>\nstream\n"
        .encode() + entries + b"\nendstream")
    file.write(f"startxref\n{xref}\n%%EOF\n".encode())
    return file.tell()


@unittest.skipUnless(find_spec("pikepdf"), "run inside the document parser image")
class PdfRangeTests(unittest.TestCase):
    def test_renders_second_page_from_64_bit_cross_reference(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with (root / "source.pdf").open("w+b") as file:
                size = sparse_pdf(file)
                transferred = 0
                def fetch(start, end):
                    nonlocal transferred
                    transferred += end - start
                    file.seek(start)
                    return file.read(end - start)
                result = process(Path("remote.pdf"), 2, root / "out", root, RangeSource(size, fetch))
                self.assertEqual(result["text"], "Final page")
                self.assertEqual(result["pages"], 2)
                self.assertEqual(result["page"], 2)
                self.assertEqual(result["status"], "complete")
                self.assertTrue((root / "out" / result["preview"]).exists())
                self.assertLess(transferred, 8 * 1024 * 1024)
