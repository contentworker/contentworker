import type { Scope } from '@contentworker/domain';
import type {
  AssetVectorMatch,
  AssetVectorRow,
  EmbeddingsProvider,
  LexicalSearchHit,
  SearchDoc,
  SearchIndex,
  SearchIndexStats,
  VectorMatch,
  VectorRow,
  VectorStore,
} from '@contentworker/ports';

/**
 * A deterministic, dependency-free embeddings provider for dev and tests. It
 * hashes tokens into a fixed-dimension bag-of-words vector and L2-normalizes it,
 * so semantically-overlapping texts score higher under cosine similarity —
 * enough to exercise the full RAG pipeline without an API key. Not for prod.
 */
export class LocalEmbeddingsProvider implements EmbeddingsProvider {
  readonly modelId = 'local-hash-v1';
  readonly dimensions: number;
  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const i = hash(token) % this.dimensions;
      v[i] = (v[i] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const key = (s: Scope) => `${s.spaceId}::${s.environmentId}`;
const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot; // inputs are already normalized
};

/**
 * In-memory SearchIndex fake: naive term matching (score = matched query
 * terms; every term must match, mirroring the real adapters' AND semantics).
 */
export class InMemorySearchIndex implements SearchIndex {
  private docs = new Map<string, { doc: SearchDoc; text: string }>();

  async stats(scope: Scope): Promise<SearchIndexStats> {
    const prefix = `${key(scope)}::`;
    return {
      documents: [...this.docs.keys()].filter((k) => k.startsWith(prefix)).length,
      engine: 'in-memory',
    };
  }

  async index(scope: Scope, doc: SearchDoc): Promise<void> {
    this.docs.set(`${key(scope)}::${doc.entryId}`, {
      doc,
      text: Object.values(doc.textByLocale).join('\n\n').toLowerCase(),
    });
  }

  async remove(scope: Scope, entryId: string): Promise<void> {
    this.docs.delete(`${key(scope)}::${entryId}`);
  }

  async clear(scope: Scope): Promise<void> {
    const prefix = `${key(scope)}::`;
    for (const k of [...this.docs.keys()]) if (k.startsWith(prefix)) this.docs.delete(k);
  }

  /** The text held for a document, for a test to look into. */
  textOf(scope: Scope, id: string): string | undefined {
    return this.docs.get(`${key(scope)}::${id}`)?.text;
  }

  async search(scope: Scope, query: string, opts: { topK: number }): Promise<LexicalSearchHit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const prefix = `${key(scope)}::`;
    const hits: LexicalSearchHit[] = [];
    for (const [k, { doc, text }] of this.docs) {
      if (!k.startsWith(prefix)) continue;
      if (terms.every((t) => text.includes(t))) {
        hits.push({ entryId: doc.entryId, score: terms.length });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.topK);
  }
}

/** In-memory VectorStore mirroring the Vectorize adapter's behavior for tests. */
export class InMemoryVectorStore implements VectorStore {
  private rows: VectorRow[] = [];
  /** Asset vectors, by scope and asset: kept apart from entries', as the adapter's namespace. */
  readonly assetRows = new Map<string, AssetVectorRow>();

  async upsertAsset(scope: Scope, row: AssetVectorRow): Promise<void> {
    this.assetRows.set(`${key(scope)}::${row.assetId}`, row);
  }

  async deleteAsset(scope: Scope, assetId: string): Promise<void> {
    this.assetRows.delete(`${key(scope)}::${assetId}`);
  }

  async queryAssets(
    scope: Scope,
    embedding: number[],
    opts: { topK: number; minScore?: number },
  ): Promise<AssetVectorMatch[]> {
    const prefix = `${key(scope)}::`;
    return [...this.assetRows.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, r]) => ({ assetId: r.assetId, score: cosine(embedding, r.embedding) }))
      .filter((m) => m.score >= (opts.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }

  async upsert(rows: VectorRow[]): Promise<void> {
    for (const row of rows) {
      // Replace any existing row with the same identity.
      this.rows = this.rows.filter(
        (r) =>
          !(
            r.entryId === row.entryId &&
            r.locale === row.locale &&
            r.chunkIndex === row.chunkIndex &&
            key(r.scope) === key(row.scope)
          ),
      );
      this.rows.push(row);
    }
  }

  async deleteByEntry(scope: Scope, entryId: string): Promise<void> {
    this.rows = this.rows.filter((r) => !(r.entryId === entryId && key(r.scope) === key(scope)));
  }

  async query(
    scope: Scope,
    embedding: number[],
    opts: { topK: number; minScore?: number },
  ): Promise<VectorMatch[]> {
    return this.rows
      .filter((r) => key(r.scope) === key(scope))
      .map((r) => ({
        entryId: r.entryId,
        chunkText: r.chunkText,
        score: cosine(embedding, r.embedding),
      }))
      .filter((m) => m.score >= (opts.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
  }
}
