import {
  MIGRATION_DEFAULT_TOKEN_CAP,
  type MigrationAgentTokenLine,
  type MigrationAgentTokens,
  type Scope,
  sumAgentTokens,
  tokenAnswer,
} from '@contentworker/domain';
import type { MigrationTokenAsk, MigrationTokenStore } from '@contentworker/ports';
import { JournaledMap } from './journaled-map';

type Line = MigrationAgentTokenLine & { readonly run: string };

/** A run's token count in memory, as the D1 store keeps it. Runs are looked up by the caller. */
export class InMemoryMigrationTokens implements MigrationTokenStore {
  /** `space::env::run::template` → the agent's line. */
  readonly lineData = new JournaledMap<string, Line>();
  /** `space::env::run` → the cap given at creation; absent, the default. */
  readonly capData = new JournaledMap<string, number>();

  constructor(private readonly hasRun: (scope: Scope, runId: string) => boolean) {}

  private runKey(scope: Scope, runId: string) {
    return `${scope.spaceId}::${scope.environmentId}::${runId}`;
  }

  private read(scope: Scope, runId: string) {
    if (!this.hasRun(scope, runId)) return null;
    const run = this.runKey(scope, runId);
    return {
      cap: this.capData.get(run) ?? MIGRATION_DEFAULT_TOKEN_CAP,
      lines: [...this.lineData.entries()].map(([, l]) => l).filter((l) => l.run === run),
    };
  }

  setCap(scope: Scope, runId: string, cap: number): void {
    this.capData.set(this.runKey(scope, runId), cap);
  }

  async reserveAgentTokens(scope: Scope, runId: string, ask: MigrationTokenAsk) {
    const now = this.read(scope, runId);
    if (!now) return 'gone' as const;
    const answer = tokenAnswer(now.cap, now.lines, ask);
    if (answer !== 'granted') return answer;
    const run = this.runKey(scope, runId);
    this.lineData.set(`${run}::${ask.templateId}`, {
      run,
      templateId: ask.templateId,
      seq: ask.seq,
      spent: ask.spent,
      reserved: ask.tokens,
      reservedUntil: ask.until,
      capped: false,
    });
    return 'granted' as const;
  }

  async askAgentTokens(scope: Scope, runId: string, ask: Omit<MigrationTokenAsk, 'until'>) {
    const now = this.read(scope, runId);
    return now ? tokenAnswer(now.cap, now.lines, ask) : ('gone' as const);
  }

  async settleAgentTokens(
    scope: Scope,
    runId: string,
    line: { templateId: string; seq: number; spent: number },
  ): Promise<void> {
    const key = `${this.runKey(scope, runId)}::${line.templateId}`;
    const now = this.lineData.get(key);
    if (!now || now.seq > line.seq) return;
    this.lineData.set(key, { ...now, spent: line.spent, reserved: 0, reservedUntil: null });
  }

  async capAgentTokens(
    scope: Scope,
    runId: string,
    line: { templateId: string; seq: number; spent: number },
  ): Promise<void> {
    if (!this.hasRun(scope, runId)) return;
    const run = this.runKey(scope, runId);
    const key = `${run}::${line.templateId}`;
    const now = this.lineData.get(key);
    if (now && now.seq > line.seq) return;
    this.lineData.set(key, {
      run,
      templateId: line.templateId,
      seq: line.seq,
      spent: line.spent,
      reserved: 0,
      reservedUntil: null,
      capped: true,
    });
  }

  async agentTokens(scope: Scope, runId: string, at: string): Promise<MigrationAgentTokens | null> {
    const now = this.read(scope, runId);
    return now ? sumAgentTokens(now.cap, now.lines, at) : null;
  }
}
