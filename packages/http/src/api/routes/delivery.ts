import {
  getPublishedAsset,
  getPublishedEntry,
  hybridSearch,
  listContentTypes,
  listPublishedAssets,
  listPublishedEntries,
  liveEventFor,
  maskDeliveredFields,
  parseImageTransform,
  semanticSearch,
  transformPublishedAssetUrl,
  visibleSearchHits,
} from '@contentworker/application';
import {
  assertQueryRespectsFieldRules,
  authorizeContent,
  canAccessContentType,
  SCOPES,
  type Scope,
} from '@contentworker/domain';
import {
  buildDeliverySchema,
  type DeliveryContext,
  type DeliveryResolvers,
  type ResolvedEntry,
} from '@contentworker/graphql-gen';
import {
  type ASTNode,
  execute,
  type FragmentDefinitionNode,
  GraphQLError,
  type GraphQLSchema,
  NoSchemaIntrospectionCustomRule,
  type OperationDefinitionNode,
  parse,
  specifiedRules,
  type ValidationRule,
  validate,
} from 'graphql';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  type AuthDeps,
  type AuthVars,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
} from '../auth.js';
import { doc } from '../docs/openapi.js';
import { asset, publishedEntry, publishedEntryList, searchHits } from '../docs/schemas.js';
import { onError } from '../http.js';
import { clampCount, entryQueryFrom, MAX_PAGE_LIMIT, parseEntryQuery } from '../query.js';

/** Max reference-resolution depth a delivery client may request. */
const MAX_INCLUDE_DEPTH = 10;

/** Max GraphQL selection-set nesting accepted (abuse/complexity guard). */
const MAX_GQL_DEPTH = 12;

/** Recursively measures selection-set nesting, following fragments. */
function selectionDepth(
  node: { selectionSet?: { selections: readonly ASTNode[] } },
  fragments: Record<string, FragmentDefinitionNode>,
  depth: number,
): number {
  const selections = node.selectionSet?.selections ?? [];
  let max = depth;
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      max = Math.max(max, selectionDepth(sel, fragments, depth + 1));
    } else if (sel.kind === 'InlineFragment') {
      max = Math.max(max, selectionDepth(sel, fragments, depth));
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments[sel.name.value];
      if (frag) max = Math.max(max, selectionDepth(frag, fragments, depth));
    }
  }
  return max;
}

/** A validation rule rejecting operations whose nesting exceeds `maxDepth`. */
function depthLimitRule(maxDepth: number): ValidationRule {
  return (context) => {
    const fragments: Record<string, FragmentDefinitionNode> = {};
    for (const def of context.getDocument().definitions) {
      if (def.kind === 'FragmentDefinition') fragments[def.name.value] = def;
    }
    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const depth = selectionDepth(node, fragments, 0);
        if (depth > maxDepth) {
          context.reportError(
            new GraphQLError(`Query exceeds the maximum depth of ${maxDepth}.`, { nodes: [node] }),
          );
        }
      },
    };
  };
}

const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

const BASE = '/delivery/:space/:env';

/** Delivery API (CDA): read-only published content. Requires delivery:read. */
/**
 * The delivery routes as a standalone app, for a Worker that serves them on their own (the
 * delivery Worker's cached entrypoint and gateway). It carries the api's error mapping, so a
 * domain error answers as it does on the api (an unpublished or unknown entry is a 404), never as
 * Hono's bare 500.
 */
export function deliveryApp(routes: Hono<AuthVars>): Hono {
  const app = new Hono();
  app.onError(onError);
  app.route('/', routes);
  return app;
}

export function deliveryRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, rag, bus } = deps;
  const app = new Hono<AuthVars>();
  app.use(`${BASE}/*`, principalMiddleware(deps));
  app.use(`${BASE}/*`, environmentMiddleware(deps));

  // Hybrid (semantic + full-text, RRF-fused) by default; ?mode=semantic or
  // ?mode=lexical selects a single leg.
  app.get(
    `${BASE}/search`,
    doc('Delivery', 'Search published content', {
      ok: searchHits,
      description:
        'Hybrid search by default: Vectorize ANN + the FTS5 SearchShard full-text index, fused with Reciprocal Rank Fusion.',
      query: {
        q: 'Search query',
        mode: 'hybrid (default) | semantic | lexical',
        top_k: 'Max hits (default 10)',
      },
    }),
    requireScope(SCOPES.searchRead),
    async (c) => {
      const q = c.req.query('q') ?? '';
      const mode = c.req.query('mode') ?? 'hybrid';
      const opts = { topK: clampCount(c.req.query('top_k'), MAX_PAGE_LIMIT, { min: 1 }) };
      const scope = scopeOf(c);
      let hits =
        mode === 'semantic'
          ? await semanticSearch(rag, scope, q, opts)
          : await hybridSearch(rag, ctx, scope, q, {
              ...opts,
              lexicalOnly: mode === 'lexical',
            });
      hits = await visibleSearchHits(ctx, scope, c.get('principal'), hits);
      return c.json({ hits });
    },
  );

  app.get(
    `${BASE}/entries`,
    doc('Delivery', 'List published entries', {
      ok: publishedEntryList,
      query: {
        content_type: 'Filter by content type apiId',
        locale: 'Resolve fields for one locale',
        include: 'Reference resolution depth',
      },
    }),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const query = parseEntryQuery(new URL(c.req.url).searchParams);
      // Filters, ordering and search over a field the caller can't read would reveal it.
      assertQueryRespectsFieldRules(c.get('principal'), query);
      const items = await listPublishedEntries(ctx, scopeOf(c), query, {
        locale: c.req.query('locale'),
        include: clampCount(c.req.query('include'), MAX_INCLUDE_DEPTH, { min: 0 }),
      });
      // Granular RBAC: drop entries of ungranted types, mask denied fields.
      const principal = c.get('principal');
      const visible = items
        .filter((e) => canAccessContentType(principal, 'read', e.contentType))
        .map((e) => ({ ...e, fields: maskDeliveredFields(principal, e.contentType, e.fields) }));
      return c.json({ items: visible, total: visible.length });
    },
  );

  app.get(
    `${BASE}/entries/:id`,
    doc('Delivery', 'Get a published entry', {
      ok: publishedEntry,
      query: { locale: 'Resolve fields for one locale', include: 'Reference resolution depth' },
    }),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const entry = await getPublishedEntry(ctx, scopeOf(c), c.req.param('id'), {
        locale: c.req.query('locale'),
        include: clampCount(c.req.query('include'), MAX_INCLUDE_DEPTH, { min: 0 }),
      });
      const principal = c.get('principal');
      authorizeContent(principal, 'read', entry.contentType);
      return c.json({
        ...entry,
        fields: maskDeliveredFields(principal, entry.contentType, entry.fields),
      });
    },
  );

  app.get(
    `${BASE}/assets`,
    doc('Delivery', 'List published assets', { query: { limit: 'Max items' } }),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      if (c.get('principal').contentGrants) {
        return c.json({ items: [], total: 0 });
      }
      const items = await listPublishedAssets(ctx, scopeOf(c), {
        limit: clampCount(c.req.query('limit'), MAX_PAGE_LIMIT, { min: 1 }),
      });
      return c.json({ items, total: items.length });
    },
  );

  app.get(
    `${BASE}/assets/:id`,
    doc('Delivery', 'Get a published asset', { ok: asset }),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      if (c.get('principal').contentGrants) {
        return c.body(null, 403);
      }
      return c.json(await getPublishedAsset(ctx, scopeOf(c), c.req.param('id')));
    },
  );

  // Live Content API: an SSE stream of published-content changes for this scope.
  // Optional ?types=entry.published,entry.unpublished filters the event types.
  app.get(
    `${BASE}/live`,
    doc('Delivery', 'Live Content API (SSE)', {
      okDescription: 'text/event-stream of published-content domain events for this scope',
      query: { types: 'Comma-separated event-type filter, e.g. entry.published' },
    }),
    requireScope(SCOPES.deliveryRead),
    (c) => {
      const scope = scopeOf(c);
      const types = (c.req.query('types') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const principal = c.get('principal');
      return streamSSE(c, async (stream) => {
        const sub = bus.subscribe('*', async (event) => {
          if (event.scope.spaceId !== scope.spaceId) return;
          if (event.scope.environmentId !== scope.environmentId) return;
          if (types.length > 0 && !types.includes(event.type)) return;
          // Only published-content facts, and only what this principal may read (as LiveHubDO).
          const visible = liveEventFor(principal, event);
          if (!visible) return;
          await stream.writeSSE({
            event: visible.type,
            id: visible.id,
            data: JSON.stringify(visible),
          });
        });
        stream.onAbort(() => void sub.close());
        // Heartbeat so proxies keep the connection open until the client leaves.
        while (!stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15000);
        }
        await sub.close();
      });
    },
  );

  // Resolves a transformed-image URL for a published asset (resize/crop/format/
  // quality, focal-point-aware) and redirects to it, so it can back an <img src>.
  app.get(
    `${BASE}/assets/:id/transform`,
    doc('Delivery', 'Resolve a transformed image URL', {
      status: 302,
      okDescription: 'Redirects to the CDN-transformable image URL',
      query: {
        w: 'Width',
        h: 'Height',
        fit: 'Fit mode',
        fm: 'Output format: auto (AVIF/WebP negotiated from Accept) | jpg | png | webp | avif',
        q: 'Quality',
      },
    }),
    requireScope(SCOPES.deliveryRead),
    async (c) => {
      const { url } = await transformPublishedAssetUrl(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        parseImageTransform(c.req.query()),
      );
      return c.redirect(url, 302);
    },
  );

  // --- GraphQL Delivery ---------------------------------------------------
  // Schema is generated from the content types the principal may read and
  // cached content-addressed (scope + visible apiId@version set), so it
  // rebuilds automatically when the content-type set/versions change and is
  // shared across principals with the same visible shape. The schema holds NO
  // principal state — resolvers travel per-request via the GraphQL
  // contextValue (a cached schema serving another caller's closures would be
  // an RBAC bypass: field-level masking belongs to the principal, not the
  // shape). Bounded FIFO eviction keeps many-space isolates flat.
  const schemaCache = new Map<string, GraphQLSchema>();
  const MAX_SCHEMA_CACHE = 100;

  async function schemaFor(
    scope: Scope,
    principal: AuthVars['Variables']['principal'],
  ): Promise<GraphQLSchema> {
    const types = await listContentTypes(ctx, scope);
    const grantedTypes = principal.contentGrants
      ? types.filter((t) => canAccessContentType(principal, 'read', t.apiId))
      : types;
    const shape = grantedTypes
      .map((t) => `${t.apiId}@${t.version}`)
      .sort()
      .join(',');
    const key = `${scope.spaceId}:${scope.environmentId}:${shape}`;
    const cached = schemaCache.get(key);
    if (cached) return cached;
    const schema = buildDeliverySchema(grantedTypes);
    if (schemaCache.size >= MAX_SCHEMA_CACHE) {
      const oldest = schemaCache.keys().next().value;
      if (oldest !== undefined) schemaCache.delete(oldest);
    }
    schemaCache.set(key, schema);
    return schema;
  }

  function resolversFor(
    scope: Scope,
    principal: AuthVars['Variables']['principal'],
  ): DeliveryResolvers {
    // GraphQL types each field as one value (a String, not a map of locales), so a query that
    // names no locale reads the space's default one; REST, which can return the map, doesn't.
    let defaultLocale: Promise<string | undefined> | undefined;
    const localeOr = async (locale: string | undefined) => {
      if (locale) return locale;
      if (!defaultLocale) {
        defaultLocale = ctx.store.spaces.getConfig(scope).then((config) => config?.defaultLocale);
      }
      return defaultLocale;
    };
    return {
      entry: async (contentType, id, locale) => {
        if (!canAccessContentType(principal, 'read', contentType)) return null;
        try {
          const e = await getPublishedEntry(ctx, scope, id, {
            locale: await localeOr(locale),
            include: 1,
          });
          if (e.contentType !== contentType) return null;
          // Same field-level masking as the REST single-entry path.
          return {
            ...e,
            fields: maskDeliveredFields(principal, e.contentType, e.fields),
          } as ResolvedEntry;
        } catch {
          return null;
        }
      },
      collection: async (contentType, args) => {
        if (!canAccessContentType(principal, 'read', contentType)) return [];
        const raw: [string, string][] = [];
        for (const [k, v] of Object.entries(args.where ?? {})) {
          raw.push([k, Array.isArray(v) ? v.join(',') : String(v)]);
        }
        if (args.order?.length) raw.push(['order', args.order.join(',')]);
        if (args.search) raw.push(['query', args.search]);
        const parsed = entryQueryFrom(raw);
        assertQueryRespectsFieldRules(principal, { ...parsed, contentTypeApiId: contentType });
        const items = await listPublishedEntries(
          ctx,
          scope,
          { ...parsed, contentTypeApiId: contentType, limit: args.limit, skip: args.skip },
          { locale: await localeOr(args.locale), include: 1 },
        );
        return items.map((e) => ({
          ...e,
          fields: maskDeliveredFields(principal, e.contentType, e.fields),
        })) as ResolvedEntry[];
      },
      asset: async (_id, _locale) => {
        if (principal.contentGrants) return null;
        try {
          const a = await getPublishedAsset(ctx, scope, _id);
          return { id: a.assetId, file: a.file, title: a.title, description: a.description };
        } catch {
          return null;
        }
      },
      search: async (query, topK) => {
        const raw = await hybridSearch(rag, ctx, scope, query, { topK });
        return visibleSearchHits(ctx, scope, principal, raw);
      },
    };
  }

  // In-browser GraphQL explorer. Registered OUTSIDE the guarded BASE/* prefix so
  // the page loads without a token; the user sets the bearer in GraphiQL's header
  // editor and the /graphql POST it issues is what gets scope-checked.
  app.get('/graphiql/:space/:env', (c) =>
    c.html(graphiqlHtml(`/delivery/${c.req.param('space')}/${c.req.param('env')}/graphql`)),
  );

  app.all(`${BASE}/graphql`, requireScope(SCOPES.deliveryRead), async (c) => {
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => ({})) : {};
    const source = (body as { query?: string }).query ?? c.req.query('query');
    if (!source) return c.json({ errors: [{ message: 'No GraphQL query provided' }] }, 400);
    const scope = scopeOf(c);
    const principal = c.get('principal');
    const schema = await schemaFor(scope, principal);

    let document: ReturnType<typeof parse>;
    try {
      document = parse(source);
    } catch (err) {
      const message = err instanceof GraphQLError ? err.message : 'Invalid GraphQL query';
      return c.json({ errors: [{ message }] }, 400);
    }

    // Bound query depth (a single request can otherwise fan out unboundedly) and,
    // in production, forbid introspection so the per-space schema isn't exposed.
    const rules: ValidationRule[] = [...specifiedRules, depthLimitRule(MAX_GQL_DEPTH)];
    if (process.env.NODE_ENV === 'production') rules.push(NoSchemaIntrospectionCustomRule);
    const errors = validate(schema, document, rules);
    if (errors.length > 0) return c.json({ errors }, 400);

    const result = await execute({
      schema,
      document,
      // Data access is bound to THIS caller here — never inside the cached
      // schema (see schemaFor).
      contextValue: { resolvers: resolversFor(scope, principal) } satisfies DeliveryContext,
      variableValues: (body as { variables?: Record<string, unknown> }).variables,
      operationName: (body as { operationName?: string }).operationName,
    });
    // In production, redact resolver/library error messages so internal details
    // (SQL, stack fragments) don't leak; keep the path so clients can still locate
    // the failing field.
    if (result.errors && process.env.NODE_ENV === 'production') {
      return c.json({
        ...result,
        errors: result.errors.map((e) => ({ message: 'Internal error', path: e.path })),
      });
    }
    return c.json(result);
  });

  return app;
}

/** Minimal GraphiQL explorer page (CDN-hosted assets) wired to `endpoint`. */
function graphiqlHtml(endpoint: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>contentworker GraphiQL</title>
    <style>body,#graphiql{height:100vh;margin:0}</style>
    <link rel="stylesheet" href="https://unpkg.com/graphiql/graphiql.min.css" />
  </head>
  <body>
    <div id="graphiql">Loading…</div>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/graphiql/graphiql.min.js"></script>
    <script>
      const fetcher = GraphiQL.createFetcher({ url: ${JSON.stringify(endpoint)} });
      ReactDOM.createRoot(document.getElementById('graphiql')).render(
        React.createElement(GraphiQL, {
          fetcher,
          defaultHeaders: JSON.stringify({ Authorization: 'Bearer dev-cda-key' }, null, 2),
        }),
      );
    </script>
  </body>
</html>`;
}
