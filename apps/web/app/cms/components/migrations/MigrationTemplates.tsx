import { Button } from '@contentworker/ui/button';
import { Catalog, CatalogFigure, CatalogRow, CatalogTile } from '@contentworker/ui/catalog';
import { LayoutTemplate } from 'lucide-react';
import { Link } from 'react-router';
import { ToneBadge } from '~/cms/components/status';
import { count, plural } from '~/cms/lib/format';
import type { MigrationTemplateView } from '~/cms/lib/management';
import { TEMPLATE_STATUS, templatePath } from '~/cms/lib/migrations';
import { Empty } from '../page';

/**
 * A run's templates, largest first: each one a group of pages that share a structure, and so one
 * content type and one import script. A row's name opens its review (its model, its script, trying
 * and approving it, taking its pages in); it counts its pages and narrows the Pages table to them,
 * where each page is its URL (never its HTML).
 */
export function MigrationTemplates({
  templates,
  onShowPages,
}: {
  templates: readonly MigrationTemplateView[];
  onShowPages: (templateId: string) => void;
}) {
  if (templates.length === 0) {
    return (
      <Empty>
        No templates yet. Clustering groups the fetched pages that share a structure into templates.
      </Empty>
    );
  }
  return (
    <Catalog aria-label="Templates">
      {inOrder(templates).map((t) => (
        <TemplateRow key={t.id} template={t} onShowPages={onShowPages} />
      ))}
    </Catalog>
  );
}

/** Largest first; those the same size in the order of their names. */
const inOrder = (templates: readonly MigrationTemplateView[]) =>
  [...templates].sort(
    (a, b) => b.pageCount - a.pageCount || a.label.localeCompare(b.label, 'en', { numeric: true }),
  );

function TemplateRow({
  template: t,
  onShowPages,
}: {
  template: MigrationTemplateView;
  onShowPages: (templateId: string) => void;
}) {
  const status = TEMPLATE_STATUS[t.status];
  return (
    <CatalogRow
      media={
        <CatalogTile>
          <LayoutTemplate aria-hidden="true" />
        </CatalogTile>
      }
      title={
        <Link
          to={templatePath(t.runId, t.id)}
          className="hit-area font-medium text-foreground hover:underline"
        >
          {t.label}
        </Link>
      }
      meta={
        t.lastTry ? (
          <span>
            {`Last try: ${count(t.lastTry.passed)} of ${plural(t.lastTry.pages, 'sample page')} passed`}
          </span>
        ) : undefined
      }
      aside={
        <>
          <ToneBadge tone={status.tone} label={status.label} />
          <CatalogFigure label="Pages">{count(t.pageCount)}</CatalogFigure>
        </>
      }
      actions={
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Show pages of ${t.label}`}
          onClick={() => onShowPages(t.id)}
        >
          Show pages
        </Button>
      }
    />
  );
}
