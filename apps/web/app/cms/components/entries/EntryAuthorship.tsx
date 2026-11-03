import { When } from '~/cms/components/when';
import { type ActorDirectory, actorLabel } from '~/cms/lib/authorship';
import type { EntryAuthorship as Authorship } from '~/cms/lib/management';

/**
 * Who created the entry and who changed it last, at the top of the editor's details. A writer
 * reads as a teammate's name, "You", or the kind of writer it was (an agent, a workflow, an API
 * key), never as an id. An entry from before authorship was recorded says so rather than guessing.
 */
export function EntryAuthorship(props: {
  readonly authorship: Authorship;
  readonly directory?: ActorDirectory;
}) {
  const { authorship, directory } = props;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Created by</dt>
      <dd className="min-w-0 truncate">
        {actorLabel(authorship.createdBy, directory)}
        {authorship.createdAt ? (
          <span className="text-muted-foreground">
            {' · '}
            <When at={authorship.createdAt} />
          </span>
        ) : null}
      </dd>
      <dt className="text-muted-foreground">Last edited by</dt>
      <dd className="min-w-0 truncate">{actorLabel(authorship.updatedBy, directory)}</dd>
    </dl>
  );
}
