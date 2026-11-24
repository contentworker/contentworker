import { count, plural } from '~/cms/lib/format';
import type { Failures } from '~/cms/lib/migrations';
import { SourceLink } from './SourceLink';

/**
 * Pages (or files of them) a step couldn't take, each with why. Both come from the source site or
 * its script, so they are words only.
 */
export function FailureList({ title, failures }: { title: string; failures: Failures }) {
  if (failures.total === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="caption">
        {title} ({count(failures.total)})
      </h3>
      <ul
        aria-label={title}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard.
        tabIndex={0}
        className="max-h-64 space-y-1.5 overflow-auto rounded-lg text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {failures.items.map((f, i) => (
          // The same page can fail again in a later batch: its place tells them apart.
          <li key={`${i}-${f.pageId}`} className="flex min-w-0 flex-col">
            <SourceLink url={f.url} />
            <span className="wrap-anywhere text-muted-foreground">{f.error}</span>
          </li>
        ))}
      </ul>
      {failures.total > failures.items.length ? (
        <p className="text-muted-foreground text-xs">
          and {plural(failures.total - failures.items.length, 'more', 'more')}
        </p>
      ) : null}
    </div>
  );
}
