import {
  isTrigger,
  nodeSpec,
  WORKFLOW_TEMPLATES,
  type WorkflowTemplateId,
} from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { DialogError } from '@contentworker/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@contentworker/ui/field';
import { Input } from '@contentworker/ui/input';
import { NativeSelect, NativeSelectOption } from '@contentworker/ui/native-select';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Skeleton } from '@contentworker/ui/skeleton';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@contentworker/ui/table';
import { Search, Trash2, Workflow } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Ago } from '~/cms/components/ago';
import {
  DiscardAsk,
  type DiscardGuard,
  GuardCancel,
  useDiscardGuard,
} from '~/cms/components/discard-guard';
import { FormSheet } from '~/cms/components/form-sheet';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { Empty, PageHeader, Section } from '~/cms/components/page';
import { CopilotDialog } from '~/cms/components/workflow/CopilotDialog';
import { plural } from '~/cms/lib/format';
import { useClient } from '../lib/client-context';
import type { WorkflowListItem } from '../lib/management';
import { useContentTypesQuery, useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/*
 * The workflows list: one table row per workflow (its name as the link, what starts it, what it
 * covers, whether it gates publishing and its live version), a filter, and one "New workflow" sheet
 * (template or blank) beside "Draft with AI". Two workflows that start on the same thing for the same
 * content types both run, so each row names the others; creating, duplicating and drafting call
 * the workflow routes directly. Archive/restore is deferred: there is no archive use-case yet, so
 * delete (with its in-place confirm) stays.
 */

/** The table's columns, for the confirm row that spans them. */
const COLUMNS = 6;

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
  const [formDirty, setFormDirty] = useState(false);
  const [formSaving, setFormSaving] = useState(false);
  const guard = useDiscardGuard({
    open: sheetOpen,
    dirty: formDirty,
    saving: formSaving,
    onOpenChange: setSheetOpen,
  });
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
              Draft with AI
            </Button>
            <FormSheet open={sheetOpen} onOpenChange={guard.onOpenChange} label="New workflow">
              <NewWorkflowForm
                guard={guard}
                onDirty={setFormDirty}
                onSaving={setFormSaving}
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
        <div className="card space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : shown.length ? (
        <Section
          title="All workflows"
          flush
          actions={
            <span className="text-muted-foreground text-xs tabular">
              {plural(shown.length, 'workflow')}
            </span>
          }
        >
          <Table stack="cards" caption="All workflows">
            <TableHead>
              <Tr>
                <Th>Workflow</Th>
                <Th>Starts</Th>
                <Th>Covers</Th>
                <Th>Publishing</Th>
                <Th>Version</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </Tr>
            </TableHead>
            <TableBody>
              {shown.map((w) => (
                <WorkflowRow key={w.id} w={w} all={workflows} typeName={typeName} onOpen={open} />
              ))}
            </TableBody>
          </Table>
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
export function gatingLabel(w: Pick<WorkflowListItem, 'gatesPublish' | 'publishGated'>): string {
  if (w.publishGated) {
    return w.gatesPublish
      ? 'Only through this workflow'
      : 'Only through this workflow (the draft turns it off)';
  }
  return w.gatesPublish ? 'Not gated (the draft gates; publish to apply)' : 'Not gated';
}

/** The New workflow sheet's form: a name, then a template or a blank start. */
function NewWorkflowForm({
  onCreated,
  guard,
  onDirty,
  onSaving,
}: {
  onCreated: (id: string) => Promise<void>;
  guard: DiscardGuard;
  onDirty: (dirty: boolean) => void;
  onSaving: (saving: boolean) => void;
}) {
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
  const dirty = name.trim() !== '';
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onSaving(busy);
    return () => onSaving(false);
  }, [busy, onSaving]);

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
        {error ? <DialogError>{error}</DialogError> : null}
        <FieldDescription className="text-xs">
          A new workflow starts no runs until it is published.
        </FieldDescription>
        <div className="flex justify-end gap-2">
          <DiscardAsk guard={guard} message="Discard this workflow?">
            <GuardCancel guard={guard} />
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create workflow'}
            </Button>
          </DiscardAsk>
        </div>
      </FieldGroup>
    </form>
  );
}

/** The draft's trigger, in words ("Submit for review"); null when it has none yet. */
const draftTriggerOf = (w: WorkflowListItem) => {
  const t = w.graph.nodes.find(isTrigger);
  return t ? { type: t.type, label: nodeSpec(t.type)?.label ?? t.label } : null;
};

/**
 * One workflow as a table row: its name (the link) over its description, what starts its published
 * version (and which other published workflows start on the same thing, as the API reports it),
 * what it covers, whether it gates publishing, its live version, and Duplicate and Delete. Delete
 * asks in a row of its own beneath.
 */
function WorkflowRow({
  w,
  all,
  typeName,
  onOpen,
}: {
  w: WorkflowListItem;
  all: readonly WorkflowListItem[];
  typeName: (apiId: string) => string;
  onOpen: (id: string) => void;
}) {
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
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

  // What runs is the published version; the draft's trigger shows only where it differs.
  const published = w.publishedTrigger;
  const draft = draftTriggerOf(w);
  const draftDiffers = !!draft && draft.type !== published?.type;
  const alongside = (w.startsAlongside ?? []).flatMap((id) => {
    const other = all.find((o) => o.id === id);
    return other ? [other.name] : [];
  });
  const manual = published?.type === 'trigger.manual';
  const steps = w.graph.nodes.length;
  const approvals = w.graph.nodes.filter((n) => n.type === 'control.approval').length;
  return (
    <>
      <Tr>
        <Td className="min-w-0 max-w-md">
          <Link
            to={`/workflows/${encodeURIComponent(w.id)}`}
            className="font-medium text-foreground hover:underline"
          >
            {w.name}
          </Link>
          <p className="line-clamp-2 text-muted-foreground text-xs leading-relaxed">
            {w.description || 'No description yet.'}
          </p>
          <p className="text-muted-foreground text-xs tabular">
            {[
              plural(steps, 'step'),
              approvals ? (approvals === 1 ? 'a person approves' : `${approvals} approvals`) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </Td>
        <Td label="Starts">
          {published ? (
            published.label
          ) : (
            <span className="text-muted-foreground">
              {w.latestVersion ? 'No trigger' : 'Not published'}
            </span>
          )}
          {draftDiffers ? (
            <p className="text-muted-foreground text-xs">Draft starts on {draft.label}</p>
          ) : null}
          {alongside.length ? (
            <p className="text-muted-foreground text-xs">
              {manual ? 'Editors choose between this and ' : 'Also starts: '}
              {alongside.join(', ')}
            </p>
          ) : null}
        </Td>
        <Td label="Covers">
          {w.contentTypes.length ? (
            w.contentTypes.map(typeName).join(', ')
          ) : (
            <span className="text-muted-foreground">Every content type</span>
          )}
        </Td>
        <Td label="Publishing">
          <span className={w.publishGated ? undefined : 'text-muted-foreground'}>
            {gatingLabel(w)}
          </span>
        </Td>
        <Td label="Version" className="whitespace-nowrap">
          {w.latestVersion ? (
            <span className="font-medium">Published v{w.latestVersion}</span>
          ) : (
            <span className="text-muted-foreground">Draft, never published</span>
          )}
          {w.updatedAt ? (
            <p className="text-muted-foreground text-xs">
              Edited <Ago at={w.updatedAt} />
            </p>
          ) : null}
        </Td>
        <Td className="text-right">
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="hit-area"
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
              className="hit-area"
              id={deleteId}
              disabled={busy}
              aria-label={`Delete “${w.name}”`}
              aria-expanded={confirming}
              onClick={() => setConfirming((v) => !v)}
            >
              <Trash2 aria-hidden="true" /> Delete
            </Button>
          </div>
        </Td>
      </Tr>
      {confirming ? (
        <Tr>
          <Td colSpan={COLUMNS}>
            <InlineConfirm
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
          </Td>
        </Tr>
      ) : null}
    </>
  );
}
