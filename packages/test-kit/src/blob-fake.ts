import type { BlobStore } from '@contentworker/ports';

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
  async getDownloadUrl(key: string) {
    return `${this.base}/${key}`;
  }
  async delete(key: string) {
    this.deletes.push(key);
    this.objects.delete(key);
  }

  /** Actually holds bytes, so checksum verification is exercised for real. */
  private readonly objects = new Map<string, string>();

  async put(key: string, body: string, _contentType: string) {
    this.objects.set(key, body);
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
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
