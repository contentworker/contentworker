"""Run inside the parser image with a Keynote fixture supplied by its author."""
import os
from pathlib import Path
import tempfile
import unittest

from parser import process, run


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
