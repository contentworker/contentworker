import {
  createAgentReview,
  createAgentSchedule,
  listAgentReviews,
  listAgentRuns,
  listAgentSchedules,
} from '@contentworker/application';
import { logger } from '@contentworker/telemetry';
import { backdated, localized, pick, prose, WORDS } from './helpers';
import type { SeedRun } from './types';

/**
 * Agent observability data: 30 days of deterministic runs (usage/cost charts),
 * pending human-in-the-loop reviews, and recurring schedules. Runs are written
 * through the store repo (there is deliberately no public "create run" API);
 * reviews and schedules go through their use-cases.
 */
export async function seedAgents(run: SeedRun, articleIds: readonly string[]): Promise<void> {
  const { ctx, scope, locale } = run;

  if ((await listAgentRuns(ctx, scope, { limit: 1 })).length === 0) {
    await seedAgentRuns(run, articleIds);
  }

  if (articleIds.length >= 8 && (await listAgentReviews(ctx, scope, {})).length === 0) {
    for (let i = 0; i < 8; i++) {
      const { field, value, note } = articleProposal(i);
      await createAgentReview(ctx, scope, {
        workflow: pick(['enrich', 'moderate', 'curate'] as const, i),
        entryId: articleIds[i]!,
        proposed: { [field]: localized(locale, value) },
        notes: [note],
      });
    }
  }

  if ((await listAgentSchedules(ctx, scope)).length === 0) {
    await createAgentSchedule(ctx, scope, {
      workflow: 'enrich',
      cron: '0 6 * * *',
      contentTypeApiId: 'article',
    });
    await createAgentSchedule(ctx, scope, {
      workflow: 'moderate',
      cron: '*/30 * * * *',
      enabled: false,
      autoApply: true,
    });
  }
}

/**
 * Records a deterministic spread of agent runs across the last 60 days so the
 * dashboard's usage-trend, throughput, and per-workflow cards render
 * real-looking data with month-over-month shape. Timestamps are backdated off
 * the injected clock; tokens and statuses follow a fixed pattern (no
 * randomness) for reproducible demos. Runs reference real seeded entries so
 * drill-downs resolve.
 */
async function seedAgentRuns(run: SeedRun, articleIds: readonly string[]): Promise<void> {
  const { ctx, scope } = run;
  const now = ctx.clock.now();
  const workflows = ['enrich', 'moderate', 'generate', 'curate', 'repurpose'] as const;
  const statuses = [
    'completed',
    'completed',
    'completed',
    'applied',
    'needs_review',
    'held',
    'failed',
  ] as const;

  let n = 0;
  for (let day = 59; day >= 0; day--) {
    // 0–5 runs per day, denser toward the present so week-over-week trends up.
    const count = Math.max(0, Math.round(5 - day / 12 + (day % 2 === 0 ? 1 : 0)) % 6);
    for (let k = 0; k < count; k++) {
      const workflow = workflows[n % workflows.length]!;
      await ctx.store.agentRuns.record(scope, {
        id: ctx.ids.newId(),
        workflow,
        entryId: articleIds.length ? pick(articleIds, n) : '',
        status: statuses[n % statuses.length]!,
        decisions: [`${workflow} pass ${n + 1}`],
        inputTokens: 420 + ((n * 137) % 900),
        outputTokens: 130 + ((n * 71) % 380),
        createdAt: backdated(now, day, 9 + ((k * 3) % 12)),
      });
      n++;
    }
  }
  logger.info({ runs: n }, 'seed: created sample agent runs');
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The proposal seeded for generated article `i`: a rewrite of that article's real summary or
 * body (built from the same word lists as the corpus, so it stays deterministic), with the
 * reason kept for the note. Approvals diffs the proposed value against the entry's current one,
 * so the value has to read like content an agent would actually write, never like a label.
 */
function articleProposal(i: number): {
  field: 'summary' | 'body';
  value: string;
  note: string;
} {
  const topic = pick(WORDS.topics, i);
  const audience = pick(WORDS.audiences, i);
  const outcome = pick(WORDS.outcomes, i);
  const body = prose(i);
  // The corpus body's second paragraph ends on an unattributed result; see `prose`.
  const claim = `Teams that adopted this ${outcome}.`;
  // Only the first eight articles get one; article 7 is the corpus's first `changed` entry, whose
  // draft summary carries the patch's prefix.
  switch (i) {
    case 0:
      return {
        field: 'summary',
        value: `${capitalize(audience)} ${outcome} by getting ${topic} right.`,
        note: 'Tightened the summary to one concrete claim.',
      };
    case 1:
      return {
        field: 'summary',
        value: `A working playbook for ${topic}: the steps ${audience} took to ${outcome}.`,
        note: 'Rewrote the summary for practitioners, leading with what to do.',
      };
    case 2:
      return {
        field: 'body',
        value: body.replace(
          claim,
          `Teams we spoke to that adopted this report that they ${outcome}.`,
        ),
        note: 'The second paragraph states a result without a source; proposed attributed wording.',
      };
    case 3:
      return {
        field: 'summary',
        value: `Why ${audience} are ${pick(WORDS.verbs, i).toLowerCase()} ${topic}, and how it helps them ${outcome}.`,
        note: 'Aligned the summary with the title.',
      };
    case 4:
      return {
        field: 'body',
        value: body.replace(` ${claim}`, `\n\n${claim}`),
        note: 'Split the second paragraph so the result stands on its own.',
      };
    case 5:
      return {
        field: 'summary',
        value: `${capitalize(outcome)}: field notes from ${audience} on ${topic}.`,
        note: 'Led the summary with the outcome.',
      };
    case 6:
      return {
        field: 'body',
        value: body.replace('is what separates', 'is often what separates'),
        note: 'Softened an absolute claim in the opening paragraph.',
      };
    default:
      return {
        field: 'summary',
        value: `What ${audience} learned running ${topic} in production.`,
        note: 'Dropped the “Revised:” prefix, which reads as an editing note rather than a summary.',
      };
  }
}
