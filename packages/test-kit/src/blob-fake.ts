import type { BlobHead, BlobObject, BlobStore, DownloadUrlOptions } from '@contentworker/ports';

/**
 * An in-memory BlobStore for dev/tests. It hands out deterministic fake
 * presigned URLs and records uploads/deletes — no bytes are stored. Mirrors the
 * R2 adapter's contract (presigned PUT for upload, URL for download).
 */
export class FakeBlobStore implements BlobStore {
  readonly uploads: { key: string; contentType: string }[] = [];
  readonly deletes: string[] = [];
  constructor(private readonly base = 'https://blob.local') {}

  async getUploadUrl(key: string, contentType: string) {
    this.uploads.push({ key, contentType });
    return { url: `${this.base}/${key}?upload=1`, headers: { 'content-type': contentType } };
  }
  /** A short-lived URL says so (`?ttl=`), so a test can tell it from the stored one. */
  async getDownloadUrl(key: string, opts?: DownloadUrlOptions) {
    const url = `${opts?.origin ?? this.base}/${key}`;
    return opts?.expiresInSeconds ? `${url}?ttl=${opts.expiresInSeconds}` : url;
  }
  async delete(key: string) {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  /** Actually holds bytes, so checksum verification is exercised for real. */
  private readonly objects = new Map<string, string | Uint8Array>();

  async put(key: string, body: string | Uint8Array, contentType: string) {
    this.objects.set(key, body);
    this.types.set(key, contentType);
    this.etags.set(key, `etag-${++this.writes}`);
  }

  /** An etag per write, as R2 gives one: the same key written again names other bytes. */
  private readonly etags = new Map<string, string>();
  private writes = 0;

  async head(key: string): Promise<BlobHead | null> {
    const bytes = this.bytes(key);
    if (!bytes) return null;
    const contentType = this.types.get(key);
    const etag = this.etags.get(key);
    return {
      size: bytes.byteLength,
      ...(contentType ? { contentType } : {}),
      ...(etag ? { etag } : {}),
    };
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    // A fake: bytes read back one char per byte (exact for the ASCII the tests write).
    return typeof body === 'string' ? body : String.fromCharCode(...body);
  }

  async deletePrefix(prefix: string, keep: (key: string) => boolean): Promise<number> {
    let deleted = 0;
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix) && !keep(key)) {
        this.objects.delete(key);
        this.deletes.push(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Every key `open` was asked for, in order: a test proves what ingest read. */
  readonly opened: string[] = [];

  async open(key: string): Promise<BlobObject | null> {
    this.opened.push(key);
    const bytes = this.bytes(key);
    if (!bytes) return null;
    const contentType = this.types.get(key);
    return {
      body: (async function* () {
        yield bytes;
      })(),
      size: bytes.byteLength,
      ...(contentType ? { contentType } : {}),
    };
  }

  private readonly types = new Map<string, string>();

  /** The stored bytes of `key`, as written (a test reads back a binary upload with this). */
  bytes(key: string): Uint8Array | null {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    return typeof body === 'string' ? Uint8Array.from(body, (c) => c.charCodeAt(0)) : body;
  }

  /**
   * Every key currently stored.
   *
   * Exists so a test can assert that a rejected operation wrote *nothing* —
   * "it also failed to store the bad bytes" is not observable through the port
   * itself, and without this the assertion silently passes either way.
   */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}
