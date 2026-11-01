import { WORKFLOW_TEMPLATES, type WorkflowTemplateId } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@contentworker/ui/field';
import { Input } from '@contentworker/ui/input';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from '@contentworker/ui/item';
import { NativeSelect, NativeSelectOption } from '@contentworker/ui/native-select';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Skeleton } from '@contentworker/ui/skeleton';
import { PencilLine, Search, Sparkles, Trash2, Workflow } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { FormSheet } from '~/cms/components/form-sheet';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { Empty, PageHeader, Section } from '~/cms/components/page';
import { CopilotDialog } from '~/cms/components/workflow/CopilotDialog';
import { plural } from '~/cms/lib/format';
import { useClient } from '../lib/client-context';
import type { WorkflowSummary } from '../lib/management';
import { useContentTypesQuery, useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/*
 * The workflows list: each workflow as a muted Item (its live version as the tile, its name as
 * the link stretched over the item, its state, description, what it covers, and its actions in the
 * footer), a filter, and one "New workflow" sheet (template or blank) beside "Draft with AI". Each
 * workflow says which content types it covers and whether it gates publishing; creating, duplicating and drafting call the workflow
 * routes directly (the assistant-driven path is PR 11). Archive/restore is deferred: there is no
 * archive use-case yet, so delete (with its in-place confirm) stays.
 */

const TEMPLATES = Object.entries(WORKFLOW_TEMPLATES).map(([id, make]) => {
  const t = make();
  return {
    id: id as WorkflowTemplateId,
    name: t.name,
    description: t.description,
    steps: t.graph.nodes.length,
  };
});

const STARTS = [
  { id: 'template', label: 'Template' },
  { id: 'blank', label: 'Blank' },
] as const;
type Start = (typeof STARTS)[number]['id'];

export function Workflows() {
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const navigate = useNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const workflowsQuery = useScopedQuery(['workflows'], () => client.listWorkflowGraphs());
  const typesQuery = useContentTypesQuery();
  const typeName = useMemo(() => {
    const m = new Map((typesQuery.data ?? []).map((t) => [t.apiId, t.name]));
    return (apiId: string) => m.get(apiId) ?? apiId;
  }, [typesQuery.data]);
  const workflows = workflowsQuery.data ?? [];
  const q = filter.trim().toLowerCase();
  const shown = workflows.filter(
    (w) => !q || w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q),
  );

  const open = (id: string) => navigate(`/workflows/${encodeURIComponent(id)}`);

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="The review each entry goes through before it is published. Runs keep the version they started on, so edits never change a running review."
        actions={
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setCopilotOpen(true)}>
              <Sparkles aria-hidden="true" /> Draft with AI
            </Button>
            <FormSheet open={sheetOpen} onOpenChange={setSheetOpen} label="New workflow">
              <NewWorkflowForm
                onCreated={async (id) => {
                  setSheetOpen(false);
                  await invalidate(['workflows']);
                  open(id);
                }}
              />
            </FormSheet>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="relative w-full sm:w-80">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or description"
            aria-label="Filter workflows"
            className="h-8 w-full pl-9"
          />
        </div>
      </div>

      {workflowsQuery.isPending ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : shown.length ? (
        <Section
          title="All workflows"
          actions={
            <span className="text-muted-foreground text-xs tabular">
              {plural(shown.length, 'workflow')}
            </span>
          }
        >
          <ul className="flex flex-col gap-2">
            {shown.map((w) => (
              <WorkflowItem key={w.id} w={w} typeName={typeName} onOpen={open} />
            ))}
          </ul>
        </Section>
      ) : (
        <Section title="All workflows">
          <Empty icon={q ? undefined : <Workflow aria-hidden="true" />}>
            {q
              ? `No workflow matches “${filter.trim()}”.`
              : 'No workflows yet. Start from a template, or draft one with AI.'}
          </Empty>
        </Section>
      )}

      <CopilotDialog
        open={copilotOpen}
        onOpenChange={setCopilotOpen}
        askName
        onApply={async (proposal, name) => {
          const { workflow } = await client.createWorkflowDraft({
            name,
            description: proposal.explanation.slice(0, 2000),
            graph: proposal.graph,
          });
          toast.success('Draft created');
          await invalidate(['workflows']);
          open(workflow.id);
        }}
      />
    </>
  );
}

/**
 * Whether publishing is gated, as publishing checks it (the latest published version), and what
 * the draft would change once published.
 */
export function gatingLabel(w: Pick<WorkflowSummary, 'gatesPublish' | 'publishGated'>): string {
  if (w.publishGated) {
    return w.gatesPublish
      ? 'Gated: entries publish only through this workflow'
      : 'Gated (the draft turns it off; publish to apply)';
  }
  return w.gatesPublish ? 'Not gated (the draft gates; not in force until published)' : 'Not gated';
}

/** The New workflow sheet's form: a name, then a template or a blank start. */
function NewWorkflowForm({ onCreated }: { onCreated: (id: string) => Promise<void> }) {
  const { client } = useClient();
  const [name, setName] = useState('');
  const [start, setStart] = useState<Start>('template');
  const [template, setTemplate] = useState<WorkflowTemplateId>(
    TEMPLATES[0]?.id ?? 'tpl-editorial-review',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const templateId = useId();
  const hintId = useId();
  const chosen = TEMPLATES.find((t) => t.id === template);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const fromTemplate = start === 'template' ? WORKFLOW_TEMPLATES[template]() : null;
    const finalName = name.trim() || fromTemplate?.name || '';
    if (!finalName) {
      setError('Give the workflow a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { workflow } = await client.createWorkflowDraft({
        name: finalName,
        description: fromTemplate?.description ?? '',
        contentTypes: fromTemplate?.contentTypes ?? [],
        gatesPublish: fromTemplate?.gatesPublish ?? false,
        graph: fromTemplate?.graph ?? { nodes: [], edges: [] },
      });
      await onCreated(workflow.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <FieldGroup className="gap-5">
        <Field>
          <div className="flex items-baseline justify-between gap-2">
            <FieldLabel htmlFor={nameId}>Name</FieldLabel>
            {start === 'template' ? (
              <span className="text-muted-foreground text-xs">Optional</span>
            ) : null}
          </div>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={start === 'template' ? chosen?.name : 'e.g. Legal review'}
            className="h-8"
            aria-invalid={error && !name.trim() ? true : undefined}
          />
        </Field>
        <FieldSet aria-describedby={hintId} className="gap-0">
          <FieldLegend variant="label" className="mb-2">
            Start from
          </FieldLegend>
          <Segmented
            aria-label="Start from"
            value={start}
            onValueChange={(v) => setStart(v as Start)}
            className="grid w-full grid-cols-2"
          >
            {STARTS.map((o) => (
              <SegmentedItem key={o.id} value={o.id}>
                {o.label}
              </SegmentedItem>
            ))}
          </Segmented>
          <FieldDescription id={hintId} className="mt-2 text-xs" aria-live="polite">
            {start === 'template'
              ? `Copies ${chosen?.name}, ${chosen?.steps} steps. You edit it before publishing.`
              : 'Starts empty: add a trigger from the palette.'}
          </FieldDescription>
        </FieldSet>
        {start === 'template' ? (
          <Field>
            <FieldLabel htmlFor={templateId}>Template</FieldLabel>
            <NativeSelect
              id={templateId}
              value={template}
              onChange={(e) => setTemplate(e.target.value as WorkflowTemplateId)}
              wrapperClassName="w-full"
              className="h-8 w-full"
            >
              {TEMPLATES.map((t) => (
                <NativeSelectOption key={t.id} value={t.id}>
                  {t.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription className="text-xs">{chosen?.description}</FieldDescription>
          </Field>
        ) : null}
        {error ? (
          <p className="text-bad text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="sm" className="self-start" disabled={busy}>
          {busy ? 'Creating…' : 'Create workflow'}
        </Button>
        <FieldDescription className="text-xs">
          A new workflow starts no runs until it is published.
        </FieldDescription>
      </FieldGroup>
    </form>
  );
}

/**
 * One workflow, as a muted Item: its live version as the tile, then its name
 * (the link, stretched over the Item), state, description and what it covers, and its actions in
 * the footer above the link.
 */
function WorkflowItem({
  w,
  typeName,
  onOpen,
}: {
  w: WorkflowSummary;
  typeName: (apiId: string) => string;
  onOpen: (id: string) => void;
}) {
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();
  const deleteId = `workflow-delete-${w.id}`;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const duplicate = () =>
    act(async () => {
      const { workflow } = await client.createWorkflowDraft({
        name: `${w.name} (copy)`.slice(0, 200),
        description: w.description,
        contentTypes: w.contentTypes,
        gatesPublish: w.gatesPublish,
        graph: w.graph,
      });
      toast.success(`Duplicated as “${workflow.name}”`);
      await invalidate(['workflows']);
      onOpen(workflow.id);
    });
  const remove = () =>
    act(async () => {
      await client.deleteWorkflow(w.id);
      toast.success('Workflow deleted');
      await invalidate(['workflows']);
    });

  const steps = w.graph.nodes.length;
  const approvals = w.graph.nodes.filter((n) => n.type === 'control.approval').length;
  return (
    <Item asChild variant="muted" size="sm" className="relative items-start hover:bg-muted">
      <li aria-labelledby={titleId}>
        <ItemMedia aria-hidden="true">
          <span className="flex size-11 items-center justify-center rounded-xl border bg-card font-semibold text-sm tabular">
            {w.latestVersion ? (
              `v${w.latestVersion}`
            ) : (
              <PencilLine className="size-4 text-muted-foreground" />
            )}
          </span>
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <h3 id={titleId} className="min-w-0 truncate">
              <Link
                to={`/workflows/${encodeURIComponent(w.id)}`}
                className="after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
              >
                {w.name}
              </Link>
            </h3>
          </ItemTitle>
          <p className="text-xs">
            {w.latestVersion ? (
              <span className="font-medium text-foreground">Published v{w.latestVersion}</span>
            ) : (
              <span className="font-medium text-muted-foreground">Draft, never published</span>
            )}
            {w.updatedAt ? (
              <span className="text-muted-foreground">
                {' '}
                · edited <Ago at={w.updatedAt} />
              </span>
            ) : null}
          </p>
          <ItemDescription className="mt-1 leading-relaxed">
            {w.description || 'No description yet.'}
          </ItemDescription>
          <dl className="mt-2 space-y-0.5 text-xs">
            <div className="flex gap-1.5">
              <dt className="shrink-0 text-muted-foreground">Covers</dt>
              <dd>
                {w.contentTypes.length
                  ? w.contentTypes.map(typeName).join(', ')
                  : 'Every content type'}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="shrink-0 text-muted-foreground">Publishing</dt>
              <dd className={w.publishGated ? 'text-foreground' : 'text-muted-foreground'}>
                {gatingLabel(w)}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="shrink-0 text-muted-foreground">Steps</dt>
              <dd className="text-muted-foreground">
                {[
                  plural(steps, 'step'),
                  approvals
                    ? approvals === 1
                      ? 'a person approves'
                      : `${approvals} approvals`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
            </div>
          </dl>
        </ItemContent>
        <ItemFooter className="relative z-10 flex-wrap justify-start border-t pt-2">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            aria-label={`Duplicate “${w.name}”`}
            onClick={() => void duplicate()}
          >
            Duplicate
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            id={deleteId}
            disabled={busy}
            aria-label={`Delete “${w.name}”`}
            aria-expanded={confirming}
            onClick={() => setConfirming((v) => !v)}
          >
            <Trash2 aria-hidden="true" /> Delete
          </Button>
          {confirming ? (
            <InlineConfirm
              className="mt-2"
              message={`Delete “${w.name}”?`}
              note="Runs already started keep their version; the draft can’t be recovered."
              onCancel={() => setConfirming(false)}
              returnFocus={() => document.getElementById(deleteId)}
            >
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  void remove();
                }}
              >
                Delete workflow
              </Button>
            </InlineConfirm>
          ) : null}
        </ItemFooter>
      </li>
    </Item>
  );
}
