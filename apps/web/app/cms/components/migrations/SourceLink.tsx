import { cn } from '@contentworker/ui/lib/utils';

/**
 * A source page by its address, opening the live page in a new tab: the run reads the site as a
 * visitor does, so this shows what it read. Only an http(s) address is a link (the API takes no
 * other); its text is mono, as every URL is.
 */
export function SourceLink({
  url,
  label = url,
  className,
  primary,
}: {
  url: string;
  label?: string;
  /** For the link itself; its text truncates on its own. */
  className?: string;
  /** The row's first focusable thing, which Load more hands focus to. */
  primary?: boolean;
}) {
  if (!/^https?:\/\//i.test(url)) {
    return <span className={cn('font-mono', className)}>{label}</span>;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      data-row-primary={primary || undefined}
      className={cn(
        'hit-area flex min-w-0 max-w-full font-mono text-link hover:underline',
        className,
      )}
    >
      {/* Truncated inside: overflow on the link itself would clip its touch target (hit-area). */}
      <span className="truncate">{label}</span>{' '}
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
