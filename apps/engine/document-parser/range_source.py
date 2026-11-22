"""Seekable reader for an immutable object. Each request is bounded and version-pinned."""
import io
from urllib.request import Request, urlopen

BLOCK = 256 * 1024
MAX_READ = 16 * 1024 * 1024


class RangeSource(io.RawIOBase):
    def __init__(self, size, fetch):
        self.size = size
        self.fetch = fetch
        self.position = 0
        self.block = b""
        self.block_start = -1

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        base = (0, self.position, self.size)[whence]
        if offset + base < 0:
            raise OSError("Seek before object")
        self.position = offset + base
        return self.position

    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def read(self, size=-1):
        available = max(0, self.size - self.position)
        length = available if size < 0 else min(size, available)
        if length > MAX_READ:
            raise ValueError("Document index exceeds reader budget")
        result = bytearray()
        while len(result) < length:
            start = self.position // BLOCK * BLOCK
            if start != self.block_start:
                end = min(start + BLOCK, self.size)
                block = self.fetch(start, end)
                if len(block) != end - start:
                    raise OSError("Incomplete object range")
                self.block = block
                self.block_start = start
            offset = self.position - start
            part = self.block[offset:offset + length - len(result)]
            result.extend(part)
            self.position += len(part)
        return bytes(result)


def signed_object(url, size, etag):
    if not url.startswith("https://") or size <= 0 or not etag or etag.startswith("W/"):
        raise ValueError("An HTTPS object URL, byte length and strong ETag are required")

    def fetch(start, end):
        request = Request(url, headers={"Range": f"bytes={start}-{end - 1}", "If-Match": etag,
                                        "Accept-Encoding": "identity"})
        with urlopen(request, timeout=30) as response:
            if (response.status != 206 or response.headers.get("ETag") != etag
                    or response.headers.get("Content-Range") != f"bytes {start}-{end - 1}/{size}"):
                raise OSError("Object changed or range request was refused")
            return response.read(end - start + 1)

    return RangeSource(size, fetch)
