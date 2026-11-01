import type {
  Cache,
  Clock,
  ContentStore,
  CostGuard,
  DecisionModel,
  HookDispatcher,
  IdGenerator,
  ImageTransformer,
  MediaPathSigner,
  VideoHost,
} from '@contentworker/ports';
import type { AiCallRecord } from './ai-provenance';

/** `live` calls the model; `mock` answers every `generateJson` from its heuristic. */
export type AiMode = 'live' | 'mock';

/**
 * The dependencies every use-case needs. Built once at the composition root
 * (`wireEdge` in packages/platform/src/wire.ts) by binding concrete adapters to the ports.
 */
export interface AppContext {
  readonly store: ContentStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Optional delivery cache; when absent, reads go straight to the store. */
  readonly cache?: Cache;
  /**
   * TTL for delivery cache entries, seconds. A garbage-collection bound only —
   * tag-version invalidation stays the correctness mechanism — so backends
   * don't accumulate every render ever produced. Default 86400 (1 day).
   */
  readonly deliveryCacheTtlSeconds?: number;
  /**
   * TTL for cached LIST results, seconds. Shorter than the single-entry TTL:
   * lists are invalidated by coarse content-type tags, so the TTL is the
   * backstop for the cases those tags over- or under-cover. Default 3600.
   */
  readonly deliveryListTtlSeconds?: number;
  /** Optional per-space AI budget governor; when absent, AI calls are unmetered. */
  readonly costGuard?: CostGuard;
  /**
   * Decision model (Clef on Workers AI): AI work that chooses among answers (moderation, picking
   * tags) asks it rather than a generative model. Absent → those use-cases ask the generative
   * model for JSON instead.
   */
  readonly decisions?: DecisionModel;
  /**
   * How `generateJson` calls the model: `mock` answers from the deterministic
   * heuristic without calling it (AI_MODE), `timeoutMs` caps each call
   * (AI_TIMEOUT_MS, default 20 000), and `log` receives one record per call
   * (composition roots bind it to the telemetry logger). Absent → live, 20 s,
   * no call log.
   */
  readonly ai?: {
    readonly mode: AiMode;
    readonly timeoutMs: number;
    readonly log?: (record: AiCallRecord) => void;
  };
  /**
   * Optional synchronous hooks on the write path. Absent — the default — means
   * the write path is untouched, not that an empty dispatch runs.
   */
  readonly hooks?: HookDispatcher;
  /**
   * Image transformation service (Cloudflare Images on edge). Absent → the
   * built-in query-param URL convention (`?w=&h=&fit=&fm=&q=`), which an
   * imgix-compatible CDN in front of the blob store can serve.
   */
  readonly images?: ImageTransformer;
  /**
   * Public origin of the media Worker (`https://media.<domain>`, MEDIA_PUBLIC_URL). Delivered
   * assets get their URLs there, built at read time. Absent → the stored file URL, without
   * renditions or a srcset (nothing would serve them). Used with {@link mediaPaths}.
   */
  readonly mediaPublicUrl?: string;
  /**
   * Makes the unguessable token in a published asset's media URL (the media Worker checks it).
   * Without it, published assets get the stored file URL, as without {@link mediaPublicUrl}.
   */
  readonly mediaPaths?: MediaPathSigner;
  /**
   * Video host (Cloudflare Stream on edge). Absent → video-asset use-cases
   * refuse with NotConfiguredError; plain blob uploads of video files still work.
   */
  readonly video?: VideoHost;
}

/** Default {@link AppContext.deliveryCacheTtlSeconds}. */
export const DEFAULT_DELIVERY_CACHE_TTL_SECONDS = 86_400;

/** Default {@link AppContext.deliveryListTtlSeconds}. */
export const DEFAULT_DELIVERY_LIST_TTL_SECONDS = 3_600;
