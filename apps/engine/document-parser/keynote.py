"""Build a bounded conversion input from a packaged Keynote document."""
import shutil
import zipfile


def conversion_package(archive, target, budget):
    entries = archive.infolist()
    if "Index/Document.iwa" not in archive.namelist():
        raise ValueError("Range conversion requires a packaged Keynote IWA document")
    # Keep the document indexes and metadata together. Omitting an index could lose slides
    # silently. Media can be omitted with an explicit partial result.
    required = [entry for entry in entries if not entry.filename.startswith("Data/")]
    remaining = budget - sum(entry.file_size for entry in required)
    if remaining < 0:
        raise ValueError("Keynote document indexes exceed the conversion budget")
    included = set(required)
    omitted = 0
    for entry in sorted((e for e in entries if e.filename.startswith("Data/")),
                        key=lambda e: (e.file_size, e.filename)):
        if entry.file_size > remaining:
            omitted += 1
            continue
        remaining -= entry.file_size
        included.add(entry)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as reduced:
        for entry in entries:
            if entry not in included:
                continue
            with archive.open(entry) as src, reduced.open(entry.filename, "w") as dest:
                shutil.copyfileobj(src, dest, length=1024 * 1024)
    return omitted
