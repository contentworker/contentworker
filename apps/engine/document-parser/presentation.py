"""Read one slide and stream its embedded media from a seekable PPTX or ZIP64 source."""
import posixpath
import shutil
import zipfile
from urllib.parse import unquote
from xml.etree import ElementTree as ET

XML_LIMIT = 8 * 1024 * 1024
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PRES_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
DRAW_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def xml_part(archive, path):
    if archive.getinfo(path).file_size > XML_LIMIT:
        raise ValueError(f"Oversized XML part: {path}")
    return ET.fromstring(archive.read(path))


def relationships(archive, owner):
    folder, name = posixpath.split(owner)
    path = posixpath.join(folder, "_rels", name + ".rels")
    try:
        root = xml_part(archive, path)
    except KeyError:
        return {}
    result = {}
    for node in root:
        if node.get("TargetMode") == "External":
            continue
        target = unquote(node.attrib["Target"])
        resolved = posixpath.normpath(posixpath.join(folder, target)).lstrip("/")
        if resolved == ".." or resolved.startswith("../"):
            raise ValueError("Relationship escapes package")
        result[node.attrib["Id"]] = (resolved, node.attrib["Type"].rsplit("/", 1)[-1])
    return result


def slides(archive):
    owner = "ppt/presentation.xml"
    rels = relationships(archive, owner)
    return [rels[node.attrib[f"{{{REL_NS}}}id"]][0] for node in
            xml_part(archive, owner).findall(f"./{{{PRES_NS}}}sldIdLst/{{{PRES_NS}}}sldId")]


def read_slide(archive, owner):
    root = xml_part(archive, owner)
    text = ["".join(n.text or "" for n in p.iter(f"{{{DRAW_NS}}}t"))
            for p in root.iter(f"{{{DRAW_NS}}}p")]
    references = relationships(archive, owner)
    media = {}
    for element in root.iter():
        for attr, value in element.attrib.items():
            if attr.startswith("{" + REL_NS + "}") and value in references:
                target, kind = references[value]
                if kind in {"image", "video", "audio", "media"}:
                    media[target] = archive.getinfo(target)
    return "\n".join(text), media


def single_slide_package(source, owner, destination, budget):
    """Write the selected slide and its transitive layout, theme and asset dependencies."""
    seen = set()
    remaining = budget
    warnings = []
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as output:
        def write_part(path, data):
            nonlocal remaining
            remaining -= len(data)
            if remaining < 0:
                raise ValueError("Slide exceeds rendering budget")
            output.writestr(path, data)

        def xml_bytes(root):
            ET.register_namespace("", "http://schemas.openxmlformats.org/package/2006/relationships")
            ET.register_namespace("p", PRES_NS)
            ET.register_namespace("r", REL_NS)
            return ET.tostring(root, encoding="utf-8", xml_declaration=True)

        def visit(path):
            nonlocal remaining
            if path in seen:
                return
            seen.add(path)
            is_presentation = path == "ppt/presentation.xml"
            rel_key = posixpath.join(posixpath.dirname(path), "_rels",
                                     posixpath.basename(path) + ".rels")
            rels = relationships(source, path)
            if is_presentation:
                root = xml_part(source, path)
                slide_list = root.find(f"{{{PRES_NS}}}sldIdLst")
                for elem in list(slide_list):
                    if rels[elem.attrib[f"{{{REL_NS}}}id"]][0] != owner:
                        slide_list.remove(elem)
                write_part(path, xml_bytes(root))
            elif path:
                info = source.getinfo(path)
                remaining -= info.file_size
                if remaining < 0:
                    raise ValueError("Slide exceeds rendering budget")
                with source.open(info) as member, output.open(path, "w") as target:
                    shutil.copyfileobj(member, target, length=1024 * 1024)
            try:
                root = xml_part(source, rel_key)
            except KeyError:
                return
            pending = []
            for rel in list(root):
                target = rels.get(rel.attrib["Id"])
                if not target:
                    root.remove(rel)
                    continue
                child, kind = target
                if ((kind == "slide" and child != owner)
                    or kind in {"notesSlide", "notesMaster", "commentAuthors", "comments",
                                "handoutMaster", "thumbnail", "audio", "video", "media"}):
                    if kind in {"audio", "video", "media"}:
                        warnings.append("Playback omitted from static preview")
                    root.remove(rel)
                else:
                    pending.append(child)
            write_part(rel_key, xml_bytes(root))
            for child in pending:
                visit(child)

        if source.getinfo("[Content_Types].xml").file_size > XML_LIMIT:
            raise ValueError("Oversized content types part")
        write_part("[Content_Types].xml", source.read("[Content_Types].xml"))
        visit("")
    return list(dict.fromkeys(warnings))
