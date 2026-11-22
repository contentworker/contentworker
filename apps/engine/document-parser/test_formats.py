"""Run inside the parser image with a Keynote fixture supplied by its author."""
import os
from pathlib import Path
import tempfile
import zipfile
import unittest

from parser import process, run
from range_source import RangeSource


@unittest.skipUnless(os.environ.get("KEYNOTE_FIXTURE"), "set KEYNOTE_FIXTURE to a one-slide deck")
class FormatCompatibility(unittest.TestCase):
    def test_text_slide_and_preview(self):
        source = Path(os.environ["KEYNOTE_FIXTURE"]).resolve()
        expected = os.environ["FIXTURE_TEXT"]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for extension in ("pptx", "pdf"):
                run("soffice", "--headless", "--convert-to", extension, "--outdir", root,
                    source, home=root)
            for path in (source, root / (source.stem + ".pptx"), root / (source.stem + ".pdf")):
                with self.subTest(format=path.suffix):
                    scratch = root / path.suffix[1:]
                    scratch.mkdir()
                    dest = scratch / "result"
                    result = process(path, 1, dest, scratch)
                    self.assertEqual(result["status"], "complete")
                    self.assertEqual(result["pages"], 1)
                    self.assertEqual("".join(expected.split()), "".join(result["text"].split()))
                    self.assertEqual((dest / result["preview"]).read_bytes()[:8], b"\x89PNG\r\n\x1a\n")

    def test_keynote_over_sparse_zip64_ranges(self):
        source = Path(os.environ["KEYNOTE_FIXTURE"])
        expected = os.environ["FIXTURE_TEXT"]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            # Copy the real Keynote package to the end of a sparse ZIP64 object. ZIP metadata
            # contains absolute 64-bit offsets, as it would after a large embedded movie.
            with (root / "sparse.key").open("w+b") as sparse:
                sparse.seek(1_000_000_000_000 - 1024 * 1024)
                with zipfile.ZipFile(source) as original, zipfile.ZipFile(sparse, "w") as deck:
                    for entry in original.infolist():
                        deck.writestr(entry.filename, original.read(entry))
                size = sparse.tell()
                transferred = 0
                def fetch(start, end):
                    nonlocal transferred
                    transferred += end - start
                    sparse.seek(start)
                    return sparse.read(end - start)
                result = process(Path("source.key"), 1, root / "result", root,
                                 RangeSource(size, fetch))
                self.assertEqual(result["status"], "complete")
                self.assertEqual(result["pages"], 1)
                self.assertEqual("".join(expected.split()), "".join(result["text"].split()))
                self.assertLess(transferred, 32 * 1024 * 1024)
