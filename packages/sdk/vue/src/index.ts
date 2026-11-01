import type {
  DeliveredEntry,
  DeliveryClient,
  EntryQuery,
  Fields,
  SearchHit,
} from '@contentworker/sdk-core';
/**
 * @contentworker/sdk-vue — Vue 3 composables over @contentworker/sdk-core, mirroring @contentworker/sdk-web's
 * React hooks. Install the client with `app.use(createContentworker(client))`
 * (in Nuxt: inside a plugin via `nuxtApp.vueApp.use(...)`), then call
 * `useEntry` / `useEntries` / `useSemanticSearch` in setup. Inputs accept
 * plain values, refs, or getters; changes re-fetch automatically.
 *
 * Fetching starts on mount (client-side), matching the React hooks' SSR
 * behavior — no request runs during server-side rendering. For server-fetched
 * Nuxt data, wrap the client's promise methods in `useAsyncData` instead.
 */
import {
  type App,
  getCurrentInstance,
  getCurrentScope,
  type InjectionKey,
  inject,
  type MaybeRefOrGetter,
  onMounted,
  onScopeDispose,
  type Plugin,
  type Ref,
  ref,
  shallowRef,
  toValue,
  watchEffect,
} from 'vue';

export interface AsyncRefs<T> {
  readonly data: Ref<T | undefined>;
  readonly error: Ref<Error | undefined>;
  readonly loading: Ref<boolean>;
}

const CLIENT_KEY: InjectionKey<DeliveryClient> = Symbol('contentworker-client');

/** App plugin supplying the Delivery client to the composables. */
export function createContentworker(client: DeliveryClient): Plugin {
  return {
    install(app: App) {
      app.provide(CLIENT_KEY, client);
    },
  };
}

export function useDeliveryClient(): DeliveryClient {
  const client = inject(CLIENT_KEY, null);
  if (!client) {
    throw new Error('useDeliveryClient requires app.use(createContentworker(client))');
  }
  return client;
}

/**
 * Reactive async state over a tracked fetch. `run` reads its reactive inputs
 * via `toValue`, so `watchEffect` re-runs it when any input changes; a version
 * counter discards stale settlements (rapid input changes never race).
 */
function useAsync<T>(
  client: DeliveryClient,
  run: (client: DeliveryClient) => Promise<T>,
): AsyncRefs<T> {
  const data = shallowRef<T | undefined>(undefined);
  const error = shallowRef<Error | undefined>(undefined);
  const loading = ref(true);
  let version = 0;
  let active = true;

  const start = () => {
    watchEffect(() => {
      const ticket = ++version;
      loading.value = true;
      error.value = undefined;
      // Parity with the React hooks: a re-fetch clears the previous data
      // rather than serving it stale alongside a new error.
      data.value = undefined;
      run(client).then(
        (value) => {
          if (active && ticket === version) {
            data.value = value;
            loading.value = false;
          }
        },
        (err) => {
          if (active && ticket === version) {
            error.value = err instanceof Error ? err : new Error(String(err));
            loading.value = false;
          }
        },
      );
    });
  };

  if (getCurrentInstance()) {
    // Component usage: fetch from mount (client-side only — SSR renders the
    // loading state, matching the React hooks).
    onMounted(start);
  } else if (typeof window !== 'undefined') {
    // Bare client-side usage (tests, stores): start immediately. On the
    // server (Nuxt plugins/stores during SSR) nothing fetches — the
    // documented no-request-during-SSR behavior holds in every branch.
    start();
  }
  // Cleanup keys on the enclosing effect scope (a component's own scope, a
  // pinia store scope, or an explicit effectScope), not just unmount.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      active = false;
    });
  }
  return { data, error, loading };
}

/** Fetches a single published entry; re-fetches when inputs change. */
export function useEntry<F extends Fields = Fields>(
  id: MaybeRefOrGetter<string>,
  opts: {
    locale?: MaybeRefOrGetter<string | undefined>;
    include?: MaybeRefOrGetter<number | undefined>;
  } = {},
): AsyncRefs<DeliveredEntry<F>> {
  const client = useDeliveryClient();
  return useAsync(client, (c) =>
    c.getEntry<F>(toValue(id), { locale: toValue(opts.locale), include: toValue(opts.include) }),
  );
}

/**
 * Lists published entries; re-fetches when the query changes. Tracking is
 * top-level: replace the query (or nested `filters`/`order` arrays), or pass
 * a getter — mutating a nested array element in place is not observed.
 */
export function useEntries<F extends Fields = Fields>(
  query: MaybeRefOrGetter<EntryQuery> = {},
): AsyncRefs<{ items: DeliveredEntry<F>[]; total: number }> {
  const client = useDeliveryClient();
  return useAsync(client, (c) => c.listEntries<F>({ ...toValue(query) }));
}

/** Semantic search over published content; an empty query yields []. */
export function useSemanticSearch(
  query: MaybeRefOrGetter<string>,
  opts: { topK?: MaybeRefOrGetter<number | undefined> } = {},
): AsyncRefs<SearchHit[]> {
  const client = useDeliveryClient();
  return useAsync(client, (c) => {
    const q = toValue(query);
    return q ? c.search(q, { topK: toValue(opts.topK) }) : Promise.resolve([]);
  });
}

export type {
  AssetPage,
  AssetQuery,
  DeliveredAsset,
  DeliveredEntry,
  DeliveryClient,
  EntryQuery,
  SearchHit,
} from '@contentworker/sdk-core';
export { assetUrl, createDeliveryClient, srcset } from '@contentworker/sdk-core';
