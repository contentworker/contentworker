import type { MigrationAgentTokens, MigrationTokenRefusal, Scope } from '@contentworker/domain';

/**
 * A migration run's token count: one line per template agent, beside the run and never part of
 * its `version`, so spending doesn't race the run's writes.
 *
 * Each line is written by one agent (its Durable Object runs one turn at a time) and holds that
 * agent's own total, not an increment: writing it twice counts once, and a later write repairs an
 * earlier one that was lost. `seq` orders the agent's writes. Each call is one statement or one
 * batch on its own, never part of a unit of work.
 */
export interface MigrationTokenStore {
  /**
   * Holds `tokens` for the agent's call `seq`, with `spent` the agent's total before it, if the
   * run's lines leave room under its cap: decided and written by one statement, so two agents
   * can't both take the last of it. Replaces the agent's earlier reservation. The same call again
   * (its answer was lost) is granted again, and holds no more.
   */
  reserveAgentTokens(
    scope: Scope,
    runId: string,
    ask: MigrationTokenAsk,
  ): Promise<'granted' | 'gone' | MigrationTokenRefusal>;
  /** What {@link reserveAgentTokens} would answer now. Only a read: the reservation decides. */
  askAgentTokens(
    scope: Scope,
    runId: string,
    ask: Omit<MigrationTokenAsk, 'until'>,
  ): Promise<'granted' | 'gone' | MigrationTokenRefusal>;
  /**
   * Records the agent's total and lets go of what it holds, unless a reservation past `seq` is on
   * record. A line that isn't there is left so.
   */
  settleAgentTokens(
    scope: Scope,
    runId: string,
    line: {
      readonly templateId: string;
      readonly seq: number;
      readonly spent: number;
      readonly at: string;
    },
  ): Promise<void>;
  /** The same, marking the agent as stopped at the cap. Writes a line when there is none. */
  capAgentTokens(
    scope: Scope,
    runId: string,
    line: {
      readonly templateId: string;
      readonly seq: number;
      readonly spent: number;
      readonly at: string;
    },
  ): Promise<void>;
  /** The run's cap and count at `at`; null when there is no such run. */
  agentTokens(scope: Scope, runId: string, at: string): Promise<MigrationAgentTokens | null>;
}

export interface MigrationTokenAsk {
  readonly templateId: string;
  readonly seq: number;
  readonly spent: number;
  readonly tokens: number;
  readonly at: string;
  /** When the reservation, if never settled, counts as spent. */
  readonly until: string;
}
