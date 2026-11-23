/**
 * Grouping a run's pages into templates by structure: greedy leader clustering over structure
 * fingerprints. Each page joins the most similar existing cluster when the Jaccard similarity of
 * its fingerprint to that cluster's first page is at least the threshold, and starts a cluster
 * otherwise. Deterministic for a given input order (callers pass pages in a stable order).
 */

/** Similarity at which a page joins a cluster. */
export const MIGRATION_CLUSTER_THRESHOLD = 0.6;
/** Sample pages chosen per template. */
export const MIGRATION_TEMPLATE_SAMPLES = 3;

export interface FingerprintedPage {
  readonly id: string;
  readonly fingerprint: readonly string[];
}

export interface StructureCluster {
  /** The first page's fingerprint, which the others matched. */
  readonly fingerprint: readonly string[];
  /** In input order. */
  readonly pageIds: string[];
  readonly samplePageIds: string[];
}

/** Jaccard similarity of two fingerprints (1 when both are empty). */
export function structureSimilarity(a: readonly string[], b: readonly string[]): number {
  return jaccard(new Set(a), new Set(b));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Clusters, largest first (a tie keeps the order the clusters started in). */
export function clusterByStructure(
  pages: readonly FingerprintedPage[],
  threshold = MIGRATION_CLUSTER_THRESHOLD,
): StructureCluster[] {
  const leaders: { fingerprint: readonly string[]; set: Set<string>; ids: string[] }[] = [];
  for (const page of pages) {
    const set = new Set(page.fingerprint);
    let best: (typeof leaders)[number] | undefined;
    let bestScore = -1;
    for (const leader of leaders) {
      const score = jaccard(set, leader.set);
      if (score > bestScore) [best, bestScore] = [leader, score];
    }
    if (best && bestScore >= threshold) best.ids.push(page.id);
    else leaders.push({ fingerprint: page.fingerprint, set, ids: [page.id] });
  }
  return leaders
    .map((l, order) => ({ l, order }))
    .sort((a, b) => b.l.ids.length - a.l.ids.length || a.order - b.order)
    .map(({ l }) => ({
      fingerprint: [...l.fingerprint],
      pageIds: l.ids,
      samplePageIds: pickSamples(l.ids, MIGRATION_TEMPLATE_SAMPLES),
    }));
}

/** `n` ids spread evenly over the list (all of them when there are no more than `n`). */
export function pickSamples(ids: readonly string[], n: number): string[] {
  if (ids.length <= n) return [...ids];
  const step = ids.length / n;
  return Array.from({ length: n }, (_, i) => ids[Math.floor(i * step)] as string);
}
