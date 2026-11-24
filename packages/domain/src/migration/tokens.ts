import { ValidationError } from '../errors';

/**
 * A migration run's token cap: what its template agents' model calls may take in all, prompt and
 * answer, whichever agents run at once. Each agent has limits of its own as well, and the space's
 * AI budget applies to every call first.
 */

/**
 * The cap of a run that names none, and of every run created before caps were kept. It is what the
 * agents' own limits add up to (20 agents of 600,000 tokens each), so a run that names no cap is
 * held no tighter than those limits hold it.
 */
export const MIGRATION_DEFAULT_TOKEN_CAP = 12_000_000;
/**
 * The most a run may be given: the agents' limits added up, and each agent's last call, which may
 * take it past its own limit.
 */
export const MIGRATION_MAX_TOKEN_CAP = 15_000_000;
/** The least: room for an agent's calls while its reservations are at their largest. */
export const MIGRATION_MIN_TOKEN_CAP = 250_000;

/** A run's cap as asked for, or the default. */
export function checkMigrationTokenCap(cap: number | undefined): number {
  if (cap === undefined) return MIGRATION_DEFAULT_TOKEN_CAP;
  if (!Number.isInteger(cap) || cap < MIGRATION_MIN_TOKEN_CAP || cap > MIGRATION_MAX_TOKEN_CAP) {
    throw new ValidationError([
      {
        field: 'agentTokenCap',
        message: `must be a whole number from ${MIGRATION_MIN_TOKEN_CAP} to ${MIGRATION_MAX_TOKEN_CAP}`,
      },
    ]);
  }
  return cap;
}

/** Where a run's agents stand against its cap. */
export interface MigrationAgentTokens {
  readonly cap: number;
  /** Counted: what calls used, and the reservation of a call whose use was never learned. */
  readonly spent: number;
  /** Held for calls under way. */
  readonly reserved: number;
  /** Templates whose agent stopped at the cap. */
  readonly stoppedTemplateIds: readonly string[];
}

/** One agent's line in its run's count. */
export interface MigrationAgentTokenLine {
  readonly templateId: string;
  /** The agent's last reservation, counted up from 1. */
  readonly seq: number;
  /** Everything the agent has used, as it counts it. */
  readonly spent: number;
  readonly reserved: number;
  /** When an open reservation counts as spent: its call is long over, whatever became of it. */
  readonly reservedUntil: string | null;
  readonly capped: boolean;
}

/** A run's count from its agents' lines, at `at`. */
export function sumAgentTokens(
  cap: number,
  lines: readonly MigrationAgentTokenLine[],
  at: string,
): MigrationAgentTokens {
  let spent = 0;
  let reserved = 0;
  for (const line of lines) {
    spent += line.spent;
    if (line.reservedUntil !== null && line.reservedUntil > at) reserved += line.reserved;
    else spent += line.reserved;
  }
  return {
    cap,
    spent,
    reserved,
    stoppedTemplateIds: lines.filter((l) => l.capped).map((l) => l.templateId),
  };
}

/**
 * Why a reservation was refused. `capped`: what is spent leaves no room for it. `wait`: only
 * reservations other agents hold are in the way, and some of those come back when they settle.
 * `stale`: a later reservation of the same template's agent is on record.
 */
export type MigrationTokenRefusal = 'capped' | 'wait' | 'stale';

/** What a reservation would be answered, the agent's own line left out: it would be replaced. */
export function tokenAnswer(
  cap: number,
  lines: readonly MigrationAgentTokenLine[],
  ask: Parameters<typeof tokenRefusal>[2],
): 'granted' | MigrationTokenRefusal {
  const held = lines
    .filter((l) => l.templateId !== ask.templateId)
    .reduce((n, l) => n + l.spent + l.reserved, ask.spent + ask.tokens);
  const own = lines.find((l) => l.templateId === ask.templateId);
  if (held <= cap && !(own && own.seq > ask.seq)) return 'granted';
  return tokenRefusal(cap, lines, ask);
}

export function tokenRefusal(
  cap: number,
  lines: readonly MigrationAgentTokenLine[],
  ask: {
    readonly templateId: string;
    readonly seq: number;
    readonly spent: number;
    readonly tokens: number;
    readonly at: string;
  },
): MigrationTokenRefusal {
  const own = lines.find((l) => l.templateId === ask.templateId);
  if (own && own.seq > ask.seq) return 'stale';
  const others = sumAgentTokens(
    cap,
    lines.filter((l) => l !== own),
    ask.at,
  );
  return others.spent + ask.spent + ask.tokens > cap ? 'capped' : 'wait';
}
