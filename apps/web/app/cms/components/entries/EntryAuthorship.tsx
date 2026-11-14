import { Card, CardContent } from '@contentworker/ui/card';
import type { ReactNode } from 'react';
import { Ago } from '~/cms/components/ago';
import { When } from '~/cms/components/when';
import { type ActorDirectory, actorLabel } from '~/cms/lib/authorship';
import type { EntryAuthorship as Authorship } from '~/cms/lib/management';

/**
 * Who created the entry and who changed it last, at the top of the editor's details, in a card of
 * its own that never folds away: two lines are cheaper to read than a toggle. A writer reads as a
 * teammate's name, "You", or the kind of writer it was (an agent, a workflow, an API key), never
 * as an id; long names wrap rather than clip. Where the writer wasn't recorded (an entry seeded,
 * imported, or from before authorship was kept) the line says only when ("Created" and the date),
 * and with neither it is left out: nothing true would be said by "Unknown".
 */
export function EntryAuthorship(props: {
  readonly authorship: Authorship & { readonly updatedAt?: string | null };
  readonly directory?: ActorDirectory;
}) {
  const { authorship, directory } = props;
  const created = line(
    'Created',
    authorship.createdBy,
    authorship.createdAt ? <When at={authorship.createdAt} /> : null,
    directory,
  );
  const edited = line(
    'Last edited',
    authorship.updatedBy,
    authorship.updatedAt ? <Ago at={authorship.updatedAt} /> : null,
    directory,
  );
  if (!created && !edited) return null;
  return (
    <Card size="sm">
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {created}
          {edited}
        </dl>
      </CardContent>
    </Card>
  );
}

/** One line: "<what> by" and the writer, then when; just "<what>" and when without a writer. */
function line(
  what: string,
  actor: string | null | undefined,
  when: ReactNode,
  directory: ActorDirectory | undefined,
) {
  if (!actor && !when) return null;
  return (
    <>
      <dt className="text-muted-foreground">{actor ? `${what} by` : what}</dt>
      <dd className="min-w-0 break-words">
        {actor ? actorLabel(actor, directory) : null}
        {actor && when ? <span className="text-muted-foreground">{' · '}</span> : null}
        {when ? <span className="text-muted-foreground">{when}</span> : null}
      </dd>
    </>
  );
}
