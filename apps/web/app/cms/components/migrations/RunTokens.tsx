import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Link } from 'react-router';
import { Section } from '~/cms/components/page';
import { count } from '~/cms/lib/format';
import type { MigrationRunView } from '~/cms/lib/management';
import { templatePath } from '~/cms/lib/migrations';

/**
 * What the run's authoring agents may take and have, and the templates they stopped short of. Read
 * only: the cap is given when the run is created.
 */
export function RunTokens({ view }: { view: MigrationRunView }) {
  const { agentTokens: tokens, run, templates } = view;
  if (!tokens) return null;
  // One approved since needs no one to author it.
  const stopped = templates.filter(
    (t) =>
      tokens.stoppedTemplateIds.includes(t.id) &&
      (t.status === 'pending' || t.status === 'authoring'),
  );
  return (
    <Section title="Agent tokens">
      <dl className="flex flex-wrap gap-x-10 gap-y-3">
        <Amount label="Spent" value={tokens.spent} />
        <Amount label="Held for calls under way" value={tokens.reserved} />
        <Amount label="Cap" value={tokens.cap} />
      </dl>
      {stopped.length > 0 ? (
        <Alert variant="warning" className="mt-4">
          <AlertTitle>
            {stopped.length === 1
              ? 'One agent stopped at the cap'
              : `${count(stopped.length)} agents stopped at the cap`}
          </AlertTitle>
          <AlertDescription>
            <p>
              {stopped.length === 1 ? 'Its template' : 'Their templates'} can still be authored by
              hand or over MCP, and approved.
            </p>
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 touch:gap-y-4">
              {stopped.map((t) => (
                <li key={t.id}>
                  <Link
                    className="hit-area wrap-anywhere text-link hover:underline"
                    to={templatePath(run.id, t.id)}
                  >
                    {t.label}
                  </Link>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </Section>
  );
}

function Amount({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="caption">{label}</dt>
      <dd className={value ? 'font-medium tabular' : 'text-muted-foreground tabular'}>
        {count(value)}
      </dd>
    </div>
  );
}
