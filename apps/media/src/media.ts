import { WorkerEntrypoint } from 'cloudflare:workers';
import type { EdgeEnv } from '@contentworker/platform/env';
import { wireMedia } from '@contentworker/platform/wire';
import { type MediaDeps, serveMedia } from './serve';

type CachePurge = {
  purge(o: { tags: string[] }): Promise<{ success: boolean; errors: unknown[] }>;
};

/**
 * Media: the cached entrypoint. Workers Caching sits in front of it (wrangler `exports`), keyed by
 * the canonical URL the gateway builds. It is not routable from outside; only this Worker's gateway
 * calls it, with no client header at all.
 */
export class Media extends WorkerEntrypoint<EdgeEnv> {
  /** The ports the miss path reads, all read-only, from the composition root. */
  protected deps(): MediaDeps {
    if (!this.env.MEDIA_BUCKET) throw new Error('MEDIA_BUCKET is not bound');
    // Any replica: a gate miss tolerates replica lag, which the engine's second purge covers.
    const wired = wireMedia(this.env, { bookmark: 'first-unconstrained' });
    return {
      bucket: this.env.MEDIA_BUCKET,
      paths: wired.mediaPaths,
      ...(this.env.IMAGES ? { images: this.env.IMAGES } : {}),
      ...(wired.assetGate ? { gate: wired.assetGate } : {}),
      ...(wired.store ? { store: wired.store } : {}),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    return serveMedia(request, this.deps());
  }

  /** Purges cached responses by tag. Workers Caching scopes a purge to the entrypoint calling it. */
  async purge(tags: string[]): Promise<{ success: boolean; skipped?: true }> {
    const cache = (this.ctx as unknown as { cache?: CachePurge }).cache;
    // Local dev and tests have no Workers Caching.
    if (!cache) return { success: true, skipped: true };
    const r = await cache.purge({ tags });
    if (!r.success) console.error('media purge refused', JSON.stringify(r.errors));
    return { success: r.success };
  }
}
