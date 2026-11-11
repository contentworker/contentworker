import {
  type ContentRef,
  type DeliveredAsset,
  type DeliveredEntry,
  type DeliveryClient,
  type EntryPage,
  type EntryQuery,
  type Fields,
  type FollowOptions,
  followEntries,
  followEntry,
  type ImagePropsOptions,
  imageProps,
  type LiveState,
  type SearchHit,
} from '@contentworker/sdk-core';
import { mountInlineEditor } from '@contentworker/sdk-core/inline-edit';
import {
  type Capability,
  type ConnectPreviewOptions,
  connectPreview,
  type LiveFields,
  type LiveView,
  type PageMessage,
  type PreviewConnection,
} from '@contentworker/sdk-core/live-preview';
/**
 * @contentworker/sdk-web — React hooks over @contentworker/sdk-core. Provide a client via
 * `ContentworkerProvider`, then call `useEntry` / `useEntries` / `useAsset` /
 * `useSemanticSearch`, render assets with `<Image>` and blocks fields with `<Blocks>`. SSR-safe
 * (no fetch on the server unless invoked).
 */
import {
  type CSSProperties,
  createContext,
  createElement,
  type ImgHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

export interface AsyncState<T> {
  readonly data?: T;
  readonly error?: Error;
  readonly loading: boolean;
}

const ClientContext = createContext<DeliveryClient | null>(null);

/** Supplies a Delivery client to the hook tree. */
export function ContentworkerProvider(props: { client: DeliveryClient; children: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}

export function useDeliveryClient(): DeliveryClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useDeliveryClient must be used within a <ContentworkerProvider>');
  return client;
}

function useAsync<T>(run: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    run().then(
      (data) => active && setState({ data, loading: false }),
      (error) => active && setState({ error: error as Error, loading: false }),
    );
    return () => {
      active = false;
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller's own dependency array, forwarded verbatim — this hook cannot know what is in it, which is the point of taking one.
  }, deps);
  return state;
}

/** Fetches a single published entry. */
export function useEntry<F extends Fields = Fields>(
  id: string,
  opts: { locale?: string; include?: number } = {},
): AsyncState<DeliveredEntry<F>> {
  const client = useDeliveryClient();
  return useAsync(() => client.getEntry<F>(id, opts), [id, opts.locale, opts.include]);
}

/** Fetches a single published asset (from a preview client: as it is now). */
export function useAsset(id: string, opts: { locale?: string } = {}): AsyncState<DeliveredAsset> {
  const client = useDeliveryClient();
  return useAsync(() => client.getAsset(id, opts), [id, opts.locale]);
}

export interface ImageComponentProps
  extends ImagePropsOptions,
    Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes' | 'width'> {
  /** The delivered asset; nothing renders while it's `null` or `undefined` (still loading). */
  readonly asset: DeliveredAsset | null | undefined;
}

/**
 * An `<img>` for a delivered asset, with {@link imageProps} applied: the width ladder as
 * `srcSet`, `sizes`, intrinsic `width`/`height`, `alt` (alt text, else the title, else decorative),
 * lazy loading unless `priority`, the focal point as `object-position` (it shows once CSS gives
 * the image `object-fit: cover` in a box of another shape) and the dominant colour as the
 * background while it loads. Other `<img>` attributes pass through; `alt` and `style` given
 * here win. Renders nothing for an asset with no image to show (audio, a document).
 *
 * ```tsx
 * <Image asset={hero} sizes="(min-width: 960px) 960px, 100vw" priority className="hero" />
 * ```
 */
export function Image(props: ImageComponentProps): ReactElement | null {
  const { asset, sizes, width, rendition, locale, priority, style, ...rest } = props;
  if (!asset) return null;
  const image = imageProps(asset, { sizes, width, rendition, locale, priority });
  if (!image) return null;
  return createElement('img', {
    ...image,
    ...rest,
    alt: rest.alt ?? image.alt,
    style: { ...image.style, ...style } satisfies CSSProperties,
  });
}

/**
 * Lists published entries (from a preview client: as they are now). For the next page, pass the
 * answer's `nextCursor` back as `cursor` (Preview) or raise `skip` (Delivery).
 *
 * The query is compared by content, so any changed value reads again and an equal object made
 * fresh each render does not. Its values must therefore be stable across renders: memoize a
 * computed one, and never put `new Date()` or the like inline, or every render is a new read.
 */
export function useEntries<F extends Fields = Fields>(
  query: EntryQuery = {},
): AsyncState<EntryPage<F>> {
  const client = useDeliveryClient();
  // By content: a new cursor, filter or order is a new read; a fresh but equal object is not.
  const key = JSON.stringify(query);
  return useAsync(() => client.listEntries<F>(JSON.parse(key) as EntryQuery), [client, key]);
}

/** What {@link useLiveEntry} and {@link useLiveEntries} hold: the read, and whether it is live. */
export type LiveAsyncState<T> = LiveState<T>;

/**
 * Fetches a single published entry and keeps it current: it is read again a moment after each
 * publish (its own, or a release or bulk job that includes it), and an unpublish clears `data`
 * and sets `removed`. `live` says the stream is open. Inert during SSR.
 *
 * ```tsx
 * const { data: post, removed } = useLiveEntry<PostFields>(id, { locale: 'en-US' });
 * ```
 */
export function useLiveEntry<F extends Fields = Fields>(
  id: string,
  opts: FollowOptions & { locale?: string; include?: number } = {},
): LiveAsyncState<DeliveredEntry<F>> {
  const client = useDeliveryClient();
  const [state, setState] = useState<LiveAsyncState<DeliveredEntry<F>>>(INITIAL);
  const { locale, include, delayMs } = opts;
  useEffect(() => {
    const following = followEntry<F>(client, id, { locale, include, delayMs }, setState);
    return () => following.close();
  }, [client, id, locale, include, delayMs]);
  return state;
}

/**
 * Lists published entries and keeps the list current: it is read again a moment after an entry
 * of `query.contentType` (any type, without one) is published or unpublished, or a release or
 * bulk job ships. Inert during SSR.
 */
export function useLiveEntries<F extends Fields = Fields>(
  query: EntryQuery = {},
  opts: FollowOptions = {},
): LiveAsyncState<EntryPage<F>> {
  const client = useDeliveryClient();
  const [state, setState] = useState<LiveAsyncState<EntryPage<F>>>(INITIAL);
  // By content: a query object made fresh each render must not resubscribe.
  const key = JSON.stringify(query);
  const { delayMs } = opts;
  useEffect(() => {
    const following = followEntries<F>(
      client,
      JSON.parse(key) as EntryQuery,
      { delayMs },
      setState,
    );
    return () => following.close();
  }, [client, key, delayMs]);
  return state;
}

const INITIAL = { loading: true, live: false, removed: false } as const;

/** Semantic search over published content. */
/**
 * Marks rendered values as the fields they came from:
 *
 * ```tsx
 * const editable = useEditable();
 * <h1 {...editable(entry, 'title')}>{entry.fields.title}</h1>
 * ```
 *
 * Returns nothing to spread unless the client is in preview mode, so the same
 * component ships to production without emitting edit metadata.
 */
export function useEditable() {
  const client = useDeliveryClient();
  return useCallback(
    (entry: Pick<DeliveredEntry, 'id' | 'contentType'>, field: string, locale?: string) =>
      client.editable(entry, field, { locale }),
    [client],
  );
}

/**
 * Mounts the click-to-edit overlay for as long as it is rendered.
 *
 * Renders no markup of its own — the overlay attaches to the document — so it
 * can sit anywhere in the tree. It is inert during SSR and mounts on the client.
 */
export function InlineEditor(props: {
  adminUrl?: string;
  onEdit?: (ref: ContentRef) => void;
  defaultEnabled?: boolean;
  toggle?: boolean;
}): null {
  const { adminUrl, onEdit, defaultEnabled, toggle } = props;
  useEffect(() => {
    const editor = mountInlineEditor({ adminUrl, onEdit, defaultEnabled, toggle });
    return () => editor.destroy();
  }, [adminUrl, onEdit, defaultEnabled, toggle]);
  return null;
}

/** One entry as the admin's unsaved state has it, in the locale it sent. */
export interface LiveEntry {
  readonly locale: string;
  /** The unsaved values: what saving would save. */
  readonly fields: LiveFields;
  /** Coworker's proposals on top, and which blocks to draw as ghosts. Render `view.withProposals`. */
  readonly view: LiveView;
}

/** What {@link useLivePreview} holds. */
export interface LivePreviewState {
  /** Framed and configured: false in production, so the delivered content renders as usual. */
  readonly active: boolean;
  readonly connected: boolean;
  /** Each entry the admin has sent state for, by id. */
  readonly entries: Readonly<Record<string, LiveEntry>>;
  /** The connection, for `on('select', …)` and `emit`; undefined until mounted. */
  readonly preview: PreviewConnection | undefined;
}

const ALL_CAPABILITIES: readonly Capability[] = [
  'select',
  'patch.fields',
  'patch.blocks',
  'proposals',
  'scroll',
  'layout',
];

/**
 * Connects to the admin's live preview for as long as it is rendered, returning each entry's
 * unsaved state to render instead of the delivered one. Each edit re-renders; the admin hears it
 * is on screen once React has committed it. Inert during SSR and when the page isn't framed, so
 * `entries` stays empty.
 *
 * ```tsx
 * const live = useLivePreview({
 *   adminOrigin: 'https://admin.example.com',
 *   page: { entries: [{ entryId: entry.id, contentType: entry.contentType, locale: 'en-US' }] },
 * });
 * const fields = live.entries[entry.id]?.view.withProposals ?? entry.fields;
 * ```
 */
export function useLivePreview(
  options: Omit<ConnectPreviewOptions, 'onState' | 'window' | 'capabilities'> & {
    /** What the page allows; every capability by default. */
    readonly capabilities?: readonly Capability[];
    /** What the page renders, reported to the admin with this page's URL once it connects. */
    readonly page?: { readonly entries: PageMessage['entries'] };
    readonly onState?: ConnectPreviewOptions['onState'];
  },
): LivePreviewState {
  const [state, setState] = useState<LivePreviewState>({
    active: false,
    connected: false,
    entries: {},
    preview: undefined,
  });
  // The latest callbacks and page, so a new closure each render doesn't restart the session.
  const latest = useRef(options);
  latest.current = options;
  // Resolved once the render a state caused has committed.
  const committed = useRef<(() => void)[]>([]);

  useEffect(() => {
    for (const resolve of committed.current.splice(0)) resolve();
  });

  const { adminOrigin } = options;
  const capabilities = (options.capabilities ?? ALL_CAPABILITIES).join(' ');
  useEffect(() => {
    const preview = connectPreview({
      adminOrigin,
      capabilities: capabilities.split(' ') as Capability[],
      ...(latest.current.newKey ? { newKey: latest.current.newKey } : {}),
      onState: async (entryId, locale, fields, view) => {
        const rendered = new Promise<void>((resolve) => {
          committed.current.push(resolve);
        });
        setState((s) => ({ ...s, entries: { ...s.entries, [entryId]: { locale, fields, view } } }));
        await rendered;
        await latest.current.onState?.(entryId, locale, fields, view);
      },
    });
    // Every session (the first, and each after a client-side navigation) hears what the page
    // renders: `connectPreview` holds the last report and sends it once a session connects.
    const report = () => {
      const page = latest.current.page;
      if (page) preview.emit('page', { url: window.location.href, entries: page.entries });
    };
    report();
    const offConnect = preview.on('connect', () => {
      setState((s) => ({ ...s, connected: true }));
    });
    // A session that ended took its unsaved state with it.
    const offDisconnect = preview.on('disconnect', () => {
      setState((s) => ({ ...s, connected: false, entries: {} }));
      report();
    });
    setState((s) => ({ ...s, active: preview.active, preview }));
    return () => {
      offConnect();
      offDisconnect();
      preview.close();
      // Renders that will now never commit: settle their waits, so nothing is left hanging.
      for (const resolve of committed.current.splice(0)) resolve();
      setState({ active: false, connected: false, entries: {}, preview: undefined });
    };
  }, [adminOrigin, capabilities]);

  // The page's entries changed (a route reused the component for another entry): tell the admin.
  const pageKey = JSON.stringify(options.page?.entries ?? null);
  const reported = useRef(pageKey);
  useEffect(() => {
    if (reported.current === pageKey) return;
    reported.current = pageKey;
    const page = latest.current.page;
    if (page) state.preview?.emit('page', { url: window.location.href, entries: page.entries });
  }, [pageKey, state.preview]);

  return state;
}

export function useSemanticSearch(
  query: string,
  opts: { topK?: number } = {},
): AsyncState<SearchHit[]> {
  const client = useDeliveryClient();
  return useAsync(
    () => (query ? client.search(query, opts) : Promise.resolve([])),
    [query, opts.topK],
  );
}

export type {
  AssetPage,
  AssetQuery,
  ContentRef,
  DeliveredAsset,
  DeliveredEntry,
  DeliveryClient,
  EntryPage,
  EntryQuery,
  FollowOptions,
  ImageProps,
  ImagePropsOptions,
  LiveEvent,
  LiveOptions,
  LiveState,
  LiveStatus,
  LiveSubscription,
  SearchHit,
} from '@contentworker/sdk-core';
export {
  assetUrl,
  createDeliveryClient,
  DeliveryError,
  imageProps,
  localizedText,
  srcset,
} from '@contentworker/sdk-core';
export type {
  BlockAttrs,
  BlockCatalogLike,
  BlockGhost,
  BlockGhosts,
  BlockOverrides,
  BlockValue,
  BlockVariantLike,
  BreakpointLike,
  FieldAttrs,
  PropLike,
  ResponsiveValue,
  SlotAttrs,
  UnknownBlock,
} from '@contentworker/sdk-core/blocks';
export { responsiveProp } from '@contentworker/sdk-core/blocks';
export {
  type BlockComponentProps,
  type BlockComponents,
  Blocks,
  type BlocksProps,
  type SlotNames,
  type SlotProps,
  type SlotRender,
} from './blocks.js';
