import type { MigrationTemplateStatus } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Catalog, CatalogFigure, CatalogRow, CatalogTile } from '@contentworker/ui/catalog';
import { LayoutTemplate } from 'lucide-react';
import { ToneBadge } from '~/cms/components/status';
import { count, type Tone } from '~/cms/lib/format';
import type { MigrationTemplateView } from '~/cms/lib/management';
import { Empty } from '../page';

/**
 * Where a template is on its way to a content type: waiting, being written, being approved (its
 * content type being created), or approved.
 */
const TEMPLATE_STATUS: Readonly<Record<MigrationTemplateStatus, { tone: Tone; label: string }>> = {
  pending: { tone: 'idle', label: 'Not authored' },
  // An agent drafts its model and script: a model's work, for someone to review.
  authoring: { tone: 'ai', label: 'Authoring' },
  approving: { tone: 'run', label: 'Approving' },
  approved: { tone: 'ok', label: 'Approved' },
};

/**
 * A run's templates, largest first: each one a group of pages that share a structure, and so one
 * content type and one import script to come. A row names it, counts its pages and narrows the
 * Pages table to it, where each page is its URL (never its HTML). Authoring a template (its
 * model, its script, trying and approving it) is a later step: its controls join this row's
 * actions once the API offers them.
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
    <Catalog aria-label="Templates" className="pt-0">
      {templates.map((t) => (
        <TemplateRow key={t.id} template={t} onShowPages={onShowPages} />
      ))}
    </Catalog>
  );
}

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
      title={<span className="font-medium text-foreground">{t.label}</span>}
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
