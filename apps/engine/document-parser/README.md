# Document parser

This local compatibility runner processes one page or slide per invocation. It writes a PNG preview, extracted text, a manifest, and content-addressed media to a new directory. PDF rendering uses Poppler. Image-only pages get English OCR. For PPTX, the parser reads slide order and relationships from the archive and builds a temporary one-slide deck for LibreOffice. Keynote support uses LibreOffice’s importer and can normalize media during conversion.

Run the standard-library ZIP64 test from this directory with `python3 -B -m unittest test_presentation`. Build the image from this directory with `docker build -t cw-document-parser .`. To verify the renderers, mount a one-slide Keynote document that contains the text in `FIXTURE_TEXT`. The test also exports PDF and PPTX versions and checks text and PNG output for each.

```sh
docker run --rm --network none --memory 1g \
  -v "$PWD/fixtures:/fixtures:ro" \
  -e KEYNOTE_FIXTURE=/fixtures/sample.key -e FIXTURE_TEXT='Document ingestion sample' \
  --entrypoint python3 cw-document-parser -B -m unittest discover
```

A local input uses `python3 parser.py path/to/deck.pptx 1 output-directory`. To exercise remote PPTX reads, set `DOCUMENT_SOURCE_URL` to a trusted, signed HTTPS object URL and pass `--r2-pptx --etag '"object-etag"' --size BYTES`. Each range request checks the ETag and content range. The filename argument supplies the format in this mode.

The checked limits are a 16 MiB remote index read, an 8 MiB XML part and a 256 MiB slide rendering budget. Large embedded objects exceeding the local extraction limit produce a partial result. Keynote conversion currently requires a locally available deck of at most 256 MiB. The PDF tools require a seekable local file. The runner has no production Worker binding.
