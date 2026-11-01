import {
  canAccessContentType,
  effectivePluginGrant,
  hostAllowed,
  type InstalledPlugin,
  maskDeniedFields,
  normalizeInstalledPlugin,
  type PermissionScope,
  type PluginCapability,
  type Principal,
  type Scope,
  scopeForCapability,
} from '@contentworker/domain';
import type {
  BlobStore,
  HookDispatcher,
  HookName,
  HookResult,
  PluginCapabilities,
  PluginRuntime,
  RemoteFetcher,
} from '@contentworker/ports';
import { getAsset, listAssets } from './assets';
import type { AppContext } from './context';
import { listPublishedEntries } from './delivery';
import { createEntry, updateEntry } from './entries';
import { loadPluginBundle } from './plugins';
import { getPreviewEntry, listPreviewEntries } from './preview';
import { publishEntry } from './publishing';
import { createTag, listTags } from './taxonomy';
import { assertSafeExternalUrl } from './url-safety';

/**
 * Turns installed plugins into a `HookDispatcher`.
 *
 * The write path is untouched by this: it already calls `runHook`, and plugins
 * are simply a second implementation of a port whose semantics were pinned by
 * tests in the hook-seam change. What is new here is *authority* — building the
 * capability objects a plugin is handed, from the same use-cases the HTTP API
 * and MCP tools call.
 *
 * That is the invariant the whole plugin model rests on: **a plugin can never
 * do something a human API client could not.** Every capability method below
 * goes through a use-case and carries a principal, so RBAC, field masking and
 * validation all apply exactly as they would to a person.
 */

export interface PluginHookOptions {
  /**
   * The principal a plugin acts as, overriding the derived one.
   *
   * By default a plugin acts as a principal holding *exactly* the scopes its
   * approved capabilities imply, in the space it was installed in — so a grant
   * of `content:read` alone can never read through a write path. Pass this to
   * narrow further (per-content-type grants, denied fields); it cannot widen,
   * because every capability method still goes through a use-case.
   */
  readonly principal?: Principal;
  readonly onError?: (message: string, detail: unknown) => void;
  /** Per-plugin ceiling on one hook invocation. */
  readonly timeoutMs?: number;
  /**
   * Outbound fetcher backing `network:request`. Absent means the capability is
   * not offered at all, rather than offered and quietly doing nothing.
   */
  readonly fetcher?: RemoteFetcher;
  readonly networkMaxBytes?: number;
  readonly networkTimeoutMs?: number;
}

/**
 * The principal a plugin acts as, derived from what a human approved.
 *
 * The capability→scope map is the same one `installPlugin` checked the
 * installer against, so what a plugin may do at call time is exactly what
 * someone with authority consented to at install time — no more, and never a
 * scope that came from anywhere but the approved list.
 */
function derivePrincipal(plugin: InstalledPlugin, spaceId: string): Principal {
  const scopes = new Set<PermissionScope>();
  for (const capability of grantOf(plugin)) {
    const scope = scopeForCapability(capability);
    if (scope) scopes.add(scope);
  }
  return { spaceId, kind: 'cma', scopes: [...scopes] };
}

/** What a plugin runs with: declared ∩ approved, never the approval alone. */
function grantOf(plugin: InstalledPlugin): PluginCapability[] {
  return effectivePluginGrant(plugin.manifest.capabilities, plugin.approvedCapabilities);
}

/**
 * Builds the capability objects for one invocation.
 *
 * Only granted capabilities get a key. An ungranted one is *absent*, so the
 * plugin's call fails because there is nothing to call — there is no check to
 * bypass because there is no code path.
 */
function buildCapabilities(
  ctx: AppContext,
  scope: Scope,
  principal: Principal,
  granted: readonly PluginCapability[],
  allowedHosts: readonly string[],
  options: PluginHookOptions,
): PluginCapabilities {
  const capabilities: PluginCapabilities = {};
  const has = (c: PluginCapability) => granted.includes(c);

  if (has('content:read')) {
    capabilities.content = {
      // Reads go through the preview use-case and are then filtered by the
      // principal's grants, so a plugin sees exactly what its installer would.
      async list(query: Record<string, unknown> = {}) {
        const items = await listPreviewEntries(ctx, scope, query);
        return items
          .filter((e) => canAccessContentType(principal, 'read', e.contentType))
          .map((e) => ({ ...e, fields: maskDeniedFields(principal, e.contentType, e.fields) }));
      },
      async get(id: string) {
        const entry = await getPreviewEntry(ctx, scope, id);
        if (!canAccessContentType(principal, 'read', entry.contentType)) return null;
        return { ...entry, fields: maskDeniedFields(principal, entry.contentType, entry.fields) };
      },
      async listPublished(query: Record<string, unknown> = {}) {
        return listPublishedEntries(ctx, scope, query);
      },
    };
  }

  if (has('content:write')) {
    const content = (capabilities.content ?? {}) as Record<string, unknown>;
    content.create = async (input: { contentTypeApiId: string; fields: Record<string, never> }) =>
      createEntry(ctx, scope, input);
    content.update = async (id: string, fields: Record<string, never>) =>
      updateEntry(ctx, scope, id, fields);
    capabilities.content = content;
  }

  if (has('content:publish')) {
    const content = (capabilities.content ?? {}) as Record<string, unknown>;
    // Through the same use-case as the API's publish route; the context a
    // plugin is handed has no hook dispatcher, so this cannot re-enter the
    // plugin chain.
    content.publish = async (id: string) => publishEntry(ctx, scope, id);
    capabilities.content = content;
  }

  if (has('assets:read')) {
    capabilities.assets = {
      async list(query: { limit?: number; skip?: number } = {}) {
        return listAssets(ctx, scope, query);
      },
      async get(id: string) {
        return getAsset(ctx, scope, id);
      },
    };
  }

  if (has('network:request') && options.fetcher) {
    capabilities.network = networkCapability(options.fetcher, allowedHosts, options);
  }

  if (has('taxonomy:read')) {
    capabilities.taxonomy = {
      async listTags() {
        return listTags(ctx, scope);
      },
    };
  }

  if (has('taxonomy:write')) {
    const taxonomy = (capabilities.taxonomy ?? {}) as Record<string, unknown>;
    taxonomy.createTag = async (input: { name: string }) => createTag(ctx, scope, input);
    capabilities.taxonomy = taxonomy;
  }

  // `assets:write`, `search:read`, `ai:generate` and `kv:storage` have no
  // implementation wired here yet. They stay in the vocabulary so a manifest
  // can declare them and a human can decide on them, and the sandbox reports
  // a granted-but-unprovided method as such rather than pretending. kv in
  // particular waits for a per-plugin storage seam rather than handing over a
  // shared namespace and calling it isolated.

  return capabilities;
}

/**
 * Reading from the hosts an operator allowed.
 *
 * Deliberately a **capability method, not ambient `fetch`**. The obvious design
 * — intercept the isolate's outbound so a plugin's ordinary `fetch` is filtered
 * — needs the sandbox's `globalOutbound` to be a real Fetcher carrying a
 * per-plugin allowlist, and the runtime offers no way to build one: a
 * dynamically-loaded worker cannot be passed (`DataCloneError`, by design), and
 * a parent entrypoint cannot be constructed per plugin. Both were tried against
 * a real workerd.
 *
 * So network access arrives the way every other capability does, as something
 * handed in. Ambient `fetch` stays severed, which means there is nothing to
 * bypass: a plugin cannot reach the network except through this, and this
 * cannot reach a host nobody approved.
 *
 * **Reads only.** A POST to a third party is a side effect on someone else's
 * system, which is a larger thing to grant than "may read from these hosts" and
 * deserves its own consent rather than riding along.
 */
function networkCapability(
  fetcher: RemoteFetcher,
  allowedHosts: readonly string[],
  options: PluginHookOptions,
) {
  return {
    async fetch(url: unknown) {
      if (typeof url !== 'string') throw new Error('fetch(url): url must be a string');
      // Screened even though the allowlist follows: an operator who allowlists
      // a hostname that resolves internally should not thereby hand a plugin an
      // SSRF, and the two checks answer different questions.
      assertSafeExternalUrl(url, 'url');
      const host = hostOf(url);
      if (!hostAllowed(allowedHosts, host)) {
        throw new Error(`"${host}" is not in this plugin's allowed hosts`);
      }
      const doc = await fetcher.get(url, {
        maxBytes: options.networkMaxBytes ?? PLUGIN_FETCH_MAX_BYTES,
        timeoutMs: options.networkTimeoutMs ?? PLUGIN_FETCH_TIMEOUT_MS,
      });
      return { status: doc.status, contentType: doc.contentType, body: doc.body };
    },
  };
}

/** Bounds on one plugin fetch: a plugin holds up an editor's save. */
export const PLUGIN_FETCH_MAX_BYTES = 512 * 1024;
export const PLUGIN_FETCH_TIMEOUT_MS = 5_000;

function hostOf(url: string): string {
  const withoutScheme = url.slice(url.indexOf('://') + 3);
  const end = withoutScheme.search(/[/?#]/);
  const authority = end === -1 ? withoutScheme : withoutScheme.slice(0, end);
  return (authority.slice(authority.lastIndexOf('@') + 1).split(':')[0] ?? '').toLowerCase();
}

/**
 * A dispatcher that fans a hook out to every enabled plugin registered for it.
 *
 * Plugins run sequentially in a stable order, each seeing the previous one's
 * mutations — the same contract as the in-process dispatcher, so swapping one
 * for the other cannot change the outcome.
 */
export function createPluginHookDispatcher(
  ctx: AppContext,
  blob: BlobStore,
  runtime: PluginRuntime,
  options: PluginHookOptions = {},
): HookDispatcher {
  const report = options.onError ?? (() => {});

  return {
    async dispatch<T>(hook: HookName, payload: T, scope: Scope): Promise<HookResult<T>> {
      const installed = (await ctx.store.plugins.list(scope.spaceId)).map(normalizeInstalledPlugin);
      // Ordered by id so the result does not depend on storage iteration order.
      const relevant = installed
        .filter((p) => p.enabled && p.manifest.hooks.includes(hook as never))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (relevant.length === 0) return { payload };

      let current: unknown = payload;
      for (const plugin of relevant) {
        const outcome = await invokeOne(plugin, hook, current, scope);
        if (outcome && 'veto' in outcome) return outcome as HookResult<T>;
        if (outcome) current = outcome.payload;
      }
      return { payload: current as T };
    },
  };

  async function invokeOne(
    plugin: InstalledPlugin,
    hook: HookName,
    payload: unknown,
    scope: Scope,
  ): Promise<HookResult<unknown> | null> {
    try {
      // Verified on every load, not only at install: bytes that no longer match
      // the approved checksum are not the bytes a human consented to.
      const { bundle } = await loadPluginBundle(ctx, blob, scope.spaceId, plugin.id);
      return await runtime.invoke(
        {
          pluginId: plugin.id,
          bundle,
          entrypoint: plugin.manifest.entrypoint,
          checksum: plugin.checksum,
          hook,
          payload,
          capabilities: grantOf(plugin),
          allowedHosts: plugin.manifest.allowedHosts,
          timeoutMs: options.timeoutMs,
          scope,
        },
        buildCapabilities(
          ctx,
          scope,
          options.principal ?? derivePrincipal(plugin, scope.spaceId),
          grantOf(plugin),
          plugin.manifest.allowedHosts,
          options,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report(`plugin ${plugin.id} failed on ${hook}: ${message}`, err);
      // A broken plugin must not make the CMS unwritable. A plugin that must
      // not be skipped is a policy question the registry will answer with a
      // per-plugin required flag; until then, failure means "did not run".
      return null;
    }
  }
}
