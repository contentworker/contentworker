import { Skeleton } from '@contentworker/ui/skeleton';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { entryPath } from '~/cms/components/dashboard/entry-titles';
import { ThroughputCard } from '~/cms/components/dashboard/ThroughputCard';
import { UsageByWorkflowCard } from '~/cms/components/dashboard/UsageByWorkflowCard';
import { UsageTrendCard } from '~/cms/components/dashboard/UsageTrendCard';
import { useEntriesById } from '~/cms/components/dashboard/use-entries-by-id';
import { Empty, Section } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { Mark } from '~/components/mark';
import { humanize } from '../lib/format';
import { useAgentRunsQuery } from '../lib/queries';

/**
 * Settings → AI, under the capabilities: tokens spent by agent runs and the run ledger. It lives
 * here, beside the tiers that set the cost, rather than on the editors' Overview.
 */
export function AiUsage() {
  const runs = useAgentRunsQuery().data ?? [];
  const ids = useMemo(() => runs.map((r) => r.entryId), [runs]);
  const named = useEntriesById(ids);

  return (
    <section aria-labelledby="ai-usage" className="space-y-4">
      <div>
        <h2 id="ai-usage" className="section-title">
          AI usage
        </h2>
        <p className="max-w-measure text-muted-foreground text-sm">
          Tokens spent by agent runs. Each card states its time window.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <UsageTrendCard runs={runs} />
        <ThroughputCard runs={runs} />
        <UsageByWorkflowCard runs={runs} />
      </div>

      <Section
        id="agent-runs"
        title="Recent agent runs"
        description={
          runs.length > 0 ? (
            <>
              Needs review: the run proposed changes, which wait in Approvals. Held: moderation
              flagged a published entry and unpublished it.
            </>
          ) : undefined
        }
        flush={runs.length > 0}
      >
        {runs.length === 0 ? (
          <Empty icon={<Mark className="text-ai" />} title="No agent runs yet">
            Enable AGENTS_ENRICH on the worker and runs will appear here as content is published.
          </Empty>
        ) : (
          <Table stack="cards" caption="Recent agent runs">
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead>Status</TableHead>
                <TableHead numeric>Tokens (in/out)</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((r) => {
                const ref = r.entryId ? named.refs.get(r.entryId) : undefined;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{humanize(r.workflow)}</TableCell>
                    <TableCell label="Entry" className="max-w-56 truncate text-muted-foreground">
                      {ref ? (
                        <Link to={entryPath(ref)} className="underline-offset-2 hover:underline">
                          {ref.title}
                        </Link>
                      ) : r.entryId ? (
                        named.isLoading ? (
                          <Skeleton className="h-4 w-24" aria-hidden />
                        ) : (
                          'Entry no longer available'
                        )
                      ) : (
                        // A space-level run (curate, a digest) acts on no one entry.
                        '—'
                      )}
                    </TableCell>
                    <TableCell label="Status">
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell label="Tokens" numeric className="text-muted-foreground">
                      {r.inputTokens}/{r.outputTokens}
                    </TableCell>
                    <TableCell label="When" className="text-muted-foreground">
                      <Ago at={r.createdAt} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>
    </section>
  );
}
