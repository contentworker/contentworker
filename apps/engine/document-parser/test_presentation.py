"""Sparse offsets exercise the ZIP64 path without transferring a terabyte."""
from pathlib import Path
import tempfile
import unittest
import zipfile

from range_source import RangeSource
from presentation import DRAW_NS, PRES_NS, REL_NS, read_slide, slides


class CountedFile:
    def __init__(self, source):
        self.source = source
        self.bytes_read = 0

    def read(self, size=-1):
        data = self.source.read(size)
        self.bytes_read += len(data)
        return data

    def __getattr__(self, key):
        return getattr(self.source, key)


class PresentationTests(unittest.TestCase):
    def test_slide_order_and_repeated_media_above_32_bit_offsets(self):
        with tempfile.TemporaryDirectory() as folder:
            with (Path(folder) / "deck.pptx").open("w+b") as source:
                source.seek(1_000_000_000_000 - 8192)
                with zipfile.ZipFile(source, "w") as archive:
                    archive.writestr("ppt/presentation.xml",
                        f'<p:presentation xmlns:p="{PRES_NS}" xmlns:r="{REL_NS}"><p:sldIdLst>'
                        '<p:sldId r:id="b"/><p:sldId r:id="a"/></p:sldIdLst></p:presentation>')
                    archive.writestr("ppt/_rels/presentation.xml.rels",
                        '<Relationships><Relationship Id="a" Type="slide" Target="slides/a.xml"/>'
                        '<Relationship Id="b" Type="slide" Target="slides/b.xml"/></Relationships>')
                    archive.writestr("ppt/slides/b.xml", f'<p:sld xmlns:p="{PRES_NS}" '
                        f'xmlns:a="{DRAW_NS}" xmlns:r="{REL_NS}"><a:p><a:r><a:t>First slide'
                        '</a:t></a:r></a:p><a:blip r:embed="img"/><a:blip r:embed="img"/>'
                        '<a:blip r:link="external"/></p:sld>')
                    archive.writestr("ppt/slides/_rels/b.xml.rels",
                        '<Relationships><Relationship Id="img" Type="image" Target="../media/p.png"/>'
                        '<Relationship Id="external" Type="image" TargetMode="External" '
                        'Target="https://example.org/image"/></Relationships>')
                    archive.writestr("ppt/media/p.png", b"media")
                reader = CountedFile(source)
                def fetch(start, end):
                    source.seek(start)
                    return reader.read(end - start)
                ranged = RangeSource(source.seek(0, 2), fetch)
                with zipfile.ZipFile(ranged) as archive:
                    ordered = slides(archive)
                    self.assertEqual(ordered, ["ppt/slides/b.xml", "ppt/slides/a.xml"])
                    text, media = read_slide(archive, ordered[0])
                    self.assertEqual(text, "First slide")
                    self.assertEqual(list(media), ["ppt/media/p.png"])
                    self.assertEqual(archive.read(media["ppt/media/p.png"]), b"media")
                self.assertLess(reader.bytes_read, 524_288)


if __name__ == "__main__":
    unittest.main()
