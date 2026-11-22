# Document parser

This local compatibility runner processes one page or slide per invocation. It writes a PNG preview, extracted text, a manifest, and content-addressed media to a new directory. PDF rendering uses Poppler. Image-only pages get English OCR. For PPTX, the parser reads slide order and relationships from the archive and builds a temporary one-slide deck for LibreOffice. Keynote support uses LibreOffice’s importer and can normalize media during conversion.

Run the standard-library ZIP64 test from this directory with `python3 -B -m unittest test_presentation`. Build the image from this directory with `docker build -t cw-document-parser .`. To verify the renderers, mount a one-slide Keynote document that contains the text in `FIXTURE_TEXT`. The test also exports PDF and PPTX versions and checks text and PNG output for each.

```sh
docker run --rm --network none --memory 1g \
  -v "$PWD/fixtures:/fixtures:ro" \
  -e KEYNOTE_FIXTURE=/fixtures/sample.key -e FIXTURE_TEXT='Document ingestion sample' \
  --entrypoint python3 cw-document-parser -B -m unittest discover
```

A local input uses `python3 parser.py path/to/deck.pptx 1 output-directory`. To exercise remote PDF, PPTX or packaged Keynote reads, set `DOCUMENT_SOURCE_URL` to a trusted, signed HTTPS object URL and pass `--r2-object --etag '"object-etag"' --size BYTES`. Each range request checks the ETag and content range. The filename argument supplies the format in this mode.

The checked limits are a 16 MiB remote index read, an 8 MiB XML part and a 256 MiB slide rendering budget. Large embedded objects exceeding the local extraction limit produce a partial result. For packaged Keynote sources, the reader rebuilds a bounded input from ranges, reserving space for every index before copying media. If media must be omitted, the resulting page is marked partial. For ranged PDFs, the reader resolves the requested page through the cross-reference table or stream and stages just that page for Poppler. The PDF regression recovers page two beyond a sparse 64-bit offset and measures bytes read. With `DOCUMENT_PARSER_ENABLED=true`, the engine invokes the same parser through DocumentParserDO. It pins reads to the source ETag and streams derived bytes into the private version prefix in R2.
