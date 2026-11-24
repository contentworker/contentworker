import { compileWildcard, matchWildcard, type Wildcard } from './wildcard';

/**
 * robots.txt (RFC 9309): which paths a crawler may fetch, the sitemaps a site announces, and the
 * crawl delay it asks for. A run fetches as {@link MIGRATION_CRAWLER_TOKEN}: the group naming that
 * token applies if there is one, else the `*` group, else everything is allowed. Within a group
 * the longest matching rule wins, and an `allow` wins a tie.
 */

/** The product token a run announces in its User-Agent and matches robots.txt groups by. */
export const MIGRATION_CRAWLER_TOKEN = 'ContentWorker';
/** Longest crawl delay honoured, seconds: a larger one is capped rather than stalling the run. */
export const MAX_CRAWL_DELAY_SECONDS = 10;

export interface RobotsRule {
  readonly allow: boolean;
  readonly path: string;
}

export interface RobotsGroup {
  /** Lowercased product tokens, `*` for any. */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
  readonly crawlDelay?: number;
}

export interface Robots {
  readonly groups: readonly RobotsGroup[];
  readonly sitemaps: readonly string[];
}

export const ALLOW_ALL_ROBOTS: Robots = { groups: [], sitemaps: [] };

export function parseRobotsTxt(text: string): Robots {
  const groups: { agents: string[]; rules: RobotsRule[]; crawlDelay?: number }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | undefined;
  let inAgents = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      // Consecutive user-agent lines open one group together.
      if (!current || !inAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // An empty disallow allows everything: no rule.
      if (value) current.rules.push({ allow: key === 'allow', path: value });
    } else if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }
  return { groups, sitemaps };
}

interface CompiledGroup {
  readonly rules: readonly {
    readonly allow: boolean;
    readonly length: number;
    readonly w: Wildcard;
  }[];
  readonly crawlDelay: number;
}

/** Each Robots' applicable group per token, compiled once: a run checks every URL against it. */
const COMPILED = new WeakMap<Robots, Map<string, CompiledGroup | null>>();

function compiledFor(robots: Robots, token: string): CompiledGroup | null {
  const t = token.toLowerCase();
  let byToken = COMPILED.get(robots);
  if (!byToken) {
    byToken = new Map();
    COMPILED.set(robots, byToken);
  }
  const cached = byToken.get(t);
  if (cached !== undefined) return cached;
  const named = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && t.startsWith(a)));
  const any = robots.groups.filter((g) => g.agents.includes('*'));
  // Groups for the same agent are combined, as the RFC asks.
  const groups = named.length ? named : any;
  const compiled: CompiledGroup | null = groups.length
    ? {
        rules: groups
          .flatMap((g) => g.rules)
          .map((r) => {
            const path = safeDecode(r.path);
            return { allow: r.allow, length: path.length, w: compileWildcard(path, 'robots') };
          }),
        crawlDelay: Math.max(0, ...groups.map((g) => g.crawlDelay ?? 0)),
      }
    : null;
  byToken.set(t, compiled);
  return compiled;
}

/** Whether `path` (with its query, if any) may be fetched. */
export function robotsAllows(
  robots: Robots,
  path: string,
  token = MIGRATION_CRAWLER_TOKEN,
): boolean {
  const group = compiledFor(robots, token);
  if (!group) return true;
  // robots.txt itself is always allowed.
  if (path === '/robots.txt') return true;
  const decoded = safeDecode(path);
  let best: { allow: boolean; length: number } | undefined;
  for (const rule of group.rules) {
    if (best && (rule.length < best.length || (rule.length === best.length && best.allow))) {
      continue;
    }
    if (matchWildcard(rule.w, decoded)) best = rule;
  }
  return best ? best.allow : true;
}

/** The delay between requests the site asks of the token, capped; 0 when it asks none. */
export function robotsCrawlDelay(robots: Robots, token = MIGRATION_CRAWLER_TOKEN): number {
  return Math.min(compiledFor(robots, token)?.crawlDelay ?? 0, MAX_CRAWL_DELAY_SECONDS);
}

// Rules and paths are compared percent-decoded, so `/caf%C3%A9` and `/café` are the same path.
function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}
