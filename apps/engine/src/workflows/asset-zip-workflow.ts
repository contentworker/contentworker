import { type AssetZipHostDeps, AssetZipWorkflowBase } from '@contentworker/platform/asset-zip';
import type { EdgeEnv } from '@contentworker/platform/env';
import { wireEdge } from '@contentworker/platform/wire';

/**
 * Zip downloads on Cloudflare Workflows (binding `ASSET_ZIP_WF`): one instance per job, started by
 * the events consumer from `asset_zip.requested`. Each invocation wires as a request does
 * (`wireEdge`): the store for the job's progress, and R2 for the files and the archive.
 *
 * This class is a composition-root export, deployed by the engine Worker (apps/engine).
 */
export class AssetZipWorkflow extends AssetZipWorkflowBase<EdgeEnv> {
  protected override open(): AssetZipHostDeps {
    const wired = wireEdge(this.env);
    return { ctx: wired.ctx, blob: wired.blob, close: () => wired.close() };
  }
}
