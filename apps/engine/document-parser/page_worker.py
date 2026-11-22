"""Process a pinned blob with byte ranges supplied over the private container pipe."""
import json
from pathlib import Path
import sys
import tempfile

from parser import process
from range_source import RangeSource


def request_bytes(start, end):
    print(json.dumps({"offset": start, "length": end - start}), flush=True)
    return sys.stdin.buffer.read(end - start)


def main():
    suffix, size, page = sys.argv[1:]
    # Each invocation has a fresh private container. The host retrieves its files by
    # their SHA-256 name, then destroys the container.
    output = Path("/tmp/document-output")
    with tempfile.TemporaryDirectory() as scratch:
        source = RangeSource(int(size), request_bytes)
        result = process(Path("input." + suffix), int(page), output, Path(scratch), source)
    artifacts = {p.name: p.stat().st_size for p in output.iterdir()}
    with (output / "manifest.json").open("w", encoding="utf-8") as manifest:
        json.dump(result, manifest, ensure_ascii=False)
    artifacts["manifest.json"] = (output / "manifest.json").stat().st_size
    print(json.dumps({"pages": result["pages"], "partial": bool(result["warnings"]),
                      "artifacts": artifacts}), flush=True)


if __name__ == "__main__":
    main()
