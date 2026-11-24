import {
  MIGRATION_DEFAULT_TOKEN_CAP,
  type MigrationAgentTokenLine,
  type Scope,
  sumAgentTokens,
  tokenAnswer,
  tokenRefusal,
} from '@contentworker/domain';
import type { MigrationTokenStore } from '@contentworker/ports';
import { and, eq, lte, sql } from 'drizzle-orm';
import { type Exec, mapD1Error } from './exec';
import * as schema from './schema';

/**
 * A run's token count on D1 (0054_migration_agent_tokens). A reservation is one conditional upsert:
 * D1 runs it on its own, so the sum it reads is the one it writes under. A run has at most a line
 * per template agent, all under its primary key's prefix.
 */
export function makeMigrationTokenStore(x: Exec): MigrationTokenStore {
  const db = x.db;
  const runs = schema.migrationRuns;
  const t = schema.migrationAgentTokens;

  const read = async (scope: Scope, runId: string) => {
    const rows = await db
      .select({ cap: runs.agentTokenCap, line: t })
      .from(runs)
      .leftJoin(
        t,
        and(
          eq(t.spaceId, runs.spaceId),
          eq(t.environmentId, runs.environmentId),
          eq(t.runId, runs.id),
        ),
      )
      .where(
        and(
          eq(runs.spaceId, scope.spaceId),
          eq(runs.environmentId, scope.environmentId),
          eq(runs.id, runId),
        ),
      );
    const [first] = rows;
    if (!first) return null;
    const lines = rows.flatMap(({ line }): MigrationAgentTokenLine[] =>
      line
        ? [
            {
              templateId: line.templateId,
              seq: line.seq,
              spent: line.spent,
              reserved: line.reserved,
              reservedUntil: line.reservedUntil?.toISOString() ?? null,
              capped: line.capped,
            },
          ]
        : [],
    );
    return { cap: first.cap ?? MIGRATION_DEFAULT_TOKEN_CAP, lines };
  };

  return {
    async reserveAgentTokens(scope, runId, ask) {
      let written: unknown[];
      try {
        written = await db.all(sql`
          INSERT INTO migration_agent_tokens
            (space_id, environment_id, run_id, template_id, seq, spent, reserved, reserved_until, capped, updated_at)
          SELECT r.space_id, r.environment_id, r.id, ${ask.templateId}, ${ask.seq}, ${ask.spent},
            ${ask.tokens}, ${Date.parse(ask.until)}, 0, ${Date.parse(ask.at)}
          FROM migration_runs r
          WHERE r.space_id = ${scope.spaceId} AND r.environment_id = ${scope.environmentId}
            AND r.id = ${runId}
            AND ${ask.spent + ask.tokens} + COALESCE((
              SELECT SUM(o.spent + o.reserved) FROM migration_agent_tokens o
              WHERE o.space_id = r.space_id AND o.environment_id = r.environment_id
                AND o.run_id = r.id AND o.template_id <> ${ask.templateId}
            ), 0) <= COALESCE(r.agent_token_cap, ${MIGRATION_DEFAULT_TOKEN_CAP})
          ON CONFLICT (space_id, environment_id, run_id, template_id) DO UPDATE SET
            seq = excluded.seq, spent = excluded.spent, reserved = excluded.reserved,
            reserved_until = excluded.reserved_until, capped = 0, updated_at = excluded.updated_at
          WHERE excluded.seq >= migration_agent_tokens.seq
          RETURNING seq`);
      } catch (err) {
        throw mapD1Error(err);
      }
      if (written.length > 0) return 'granted';
      const now = await read(scope, runId);
      return now ? tokenRefusal(now.cap, now.lines, ask) : 'gone';
    },
    async askAgentTokens(scope, runId, ask) {
      const now = await read(scope, runId);
      return now ? tokenAnswer(now.cap, now.lines, ask) : 'gone';
    },
    async settleAgentTokens(scope, runId, line) {
      try {
        await db
          .update(t)
          .set({
            spent: line.spent,
            reserved: 0,
            reservedUntil: null,
            updatedAt: new Date(line.at),
          })
          .where(
            and(
              eq(t.spaceId, scope.spaceId),
              eq(t.environmentId, scope.environmentId),
              eq(t.runId, runId),
              eq(t.templateId, line.templateId),
              lte(t.seq, line.seq),
            ),
          );
      } catch (err) {
        throw mapD1Error(err);
      }
    },
    async capAgentTokens(scope, runId, line) {
      try {
        await db.run(sql`
          INSERT INTO migration_agent_tokens
            (space_id, environment_id, run_id, template_id, seq, spent, reserved, reserved_until, capped, updated_at)
          SELECT r.space_id, r.environment_id, r.id, ${line.templateId}, ${line.seq}, ${line.spent},
            0, NULL, 1, ${Date.parse(line.at)}
          FROM migration_runs r
          WHERE r.space_id = ${scope.spaceId} AND r.environment_id = ${scope.environmentId}
            AND r.id = ${runId}
          ON CONFLICT (space_id, environment_id, run_id, template_id) DO UPDATE SET
            seq = excluded.seq, spent = excluded.spent, reserved = 0, reserved_until = NULL,
            capped = 1, updated_at = excluded.updated_at
          WHERE excluded.seq >= migration_agent_tokens.seq`);
      } catch (err) {
        throw mapD1Error(err);
      }
    },
    async agentTokens(scope, runId, at) {
      const now = await read(scope, runId);
      return now ? sumAgentTokens(now.cap, now.lines, at) : null;
    },
  };
}
