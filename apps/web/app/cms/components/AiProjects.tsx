import {
  AI_PERSONA_DESCRIPTION_MAX,
  AI_PERSONA_NAME_MAX,
  AI_PROJECT_DESCRIPTION_MAX,
  AI_PROJECT_INSTRUCTIONS_MAX,
  AI_PROJECT_MAX_REFERENCES,
  AI_PROJECT_NAME_MAX,
  type AiReferenceStatus,
  type Asset,
  assetKind,
  SCOPES,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Catalog, CatalogRow, CatalogTile } from '@contentworker/ui/catalog';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from '@contentworker/ui/sheet';
import { SkeletonText } from '@contentworker/ui/skeleton';
import { Textarea } from '@contentworker/ui/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, FileAudio, FileText, Plus, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { CopyButton } from '~/cms/components/copy-button';
import { DiscardAsk, GuardCancel, useDiscardGuard } from '~/cms/components/discard-guard';
import { EntityPicker } from '~/cms/components/EntityPicker';
import type { PickOption } from '~/cms/components/EntryForm';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { Section } from '~/cms/components/page';
import { ResponsiveSheetContent } from '~/cms/components/responsive-sheet';
import { ToneBadge } from '~/cms/components/status';
import {
  type DraftReference,
  draftChanged,
  draftOfProject,
  EMPTY_DRAFT,
  inputOf,
  instructionsLength,
  NO_TEXT_REASON,
  type ProjectDraft,
} from '../lib/ai-project-draft';
import { AI_PROJECTS_KEY } from '../lib/ai-projects';
import { AI_SETTINGS_KEY, useAiCapability } from '../lib/ai-settings';
import { fileSize } from '../lib/assets';
import { type ActorDirectory, actorLabel } from '../lib/authorship';
import { useClient } from '../lib/client-context';
import { plural } from '../lib/format';
import {
  type AgentScheduleSummary,
  type AIAction,
  type AiProjectInUse,
  type AiProjectSummary,
  type AiProjectView,
  apiErrorMessage,
  apiFieldIssues,
  conflictVersion,
  type ManagementClient,
  projectInUseOf,
} from '../lib/management';
import { useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

const count = new Intl.NumberFormat('en-US');

/** Which project the sheet edits: a new one, or one by id. */
type Editing = { readonly id: string } | 'new';

/**
 * Settings → AI projects: the environment's reusable contexts for AI work, the default first. A
 * row says what a project is for, how many references it has, what uses it and who changed it
 * last; its sheet edits it. Changing projects takes content:manage, and the default project and
 * which one is the default take space:admin: the screen reads the person's scopes to offer only
 * what the API would take, and the API is what refuses.
 */
export function AiProjects(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const queryClient = useQueryClient();
  const { conn } = useClient();
  const projects = useScopedQuery(AI_PROJECTS_KEY, () => client.listAiProjects(), {
    silent: true,
  });
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), { silent: true });
  const scopes = access.data?.scopes ?? [];
  const canManage = scopes.includes(SCOPES.contentManage);
  const canAdmin = scopes.includes(SCOPES.spaceAdmin);
  // What names a project, for "used by" and for a refused delete: silent, a count is a courtesy.
  const actions = useScopedQuery(['ai-actions'], () => client.listAIActions(), { silent: true });
  const schedules = useScopedQuery(['agent-schedules'], () => client.listAgentSchedules(), {
    silent: true,
  });
  // Who changed a project, by name: the team is the space admin's to read; others see "a
  // teammate" for anyone but themselves.
  const team = useScopedQuery(['team'], () => client.getTeam(), {
    silent: true,
    enabled: canAdmin,
  });
  const directory: ActorDirectory = {
    people: team.data?.people,
    me: access.data?.subject,
  };
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inUse, setInUse] = useState<{ id: string; use: AiProjectInUse } | null>(null);
  const [said, setSaid] = useState('');

  const ordered = useMemo(
    () =>
      [...(projects.data ?? [])].sort(
        (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
      ),
    [projects.data],
  );
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: [conn.space, conn.environment, ...AI_PROJECTS_KEY] });

  const setDefault = async (p: AiProjectSummary, on: boolean) => {
    setBusy(p.id);
    try {
      await client.setDefaultAiProject(on ? p.id : null, on ? p.version : undefined);
      await refresh();
      const words = on ? `“${p.name}” is the default project` : 'No project is the default now';
      toast.success(words);
      setSaid(words);
    } catch (err) {
      toast.error(
        conflictVersion(err) !== undefined
          ? `“${p.name}” changed since this page read it. Look again, then try once more.`
          : apiErrorMessage(err),
      );
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: AiProjectSummary) => {
    setBusy(p.id);
    setInUse(null);
    try {
      await client.deleteAiProject(p.id, p.version);
      await refresh();
      toast.success(`Deleted “${p.name}”`);
      setSaid(`Deleted “${p.name}”`);
    } catch (err) {
      const use = projectInUseOf(err);
      if (use) {
        setInUse({ id: p.id, use });
        // What names it may have changed too: read again, so the list below is current.
        void actions.refetch();
        void schedules.refetch();
      } else toast.error(apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const description =
    'Reusable contexts for AI work: instructions, who is writing, who it is for, and reference ' +
    'files a model may consult. Pick one when you generate, compose or ask Coworker; the default ' +
    'is used when you pick none.';

  if (projects.isError) {
    return (
      <Section title="AI projects" description={description}>
        <Alert variant="destructive">
          <AlertTitle>The AI projects didn’t load</AlertTitle>
          <AlertDescription>
            <p>{apiErrorMessage(projects.error)}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void projects.refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </Section>
    );
  }

  return (
    <Section
      title="AI projects"
      description={description}
      flush
      actions={
        canManage ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden="true" /> New project
          </Button>
        ) : undefined
      }
    >
      <p className="sr-only" role="status">
        {said}
      </p>
      {!access.isPending && !canManage ? (
        <p className="max-w-measure px-(--card-spacing) pb-3 text-muted-foreground text-sm">
          Changing AI projects takes the content:manage scope. They’re shown here read-only.
        </p>
      ) : null}
      {projects.isPending ? (
        <div aria-busy="true" className="border-t px-(--card-spacing) py-4">
          <LoadingStatus>Loading the AI projects…</LoadingStatus>
          <SkeletonText width="16rem" />
        </div>
      ) : ordered.length === 0 ? (
        <p className="max-w-measure border-t px-(--card-spacing) py-4 text-muted-foreground text-sm">
          No AI projects yet.{' '}
          {canManage
            ? 'Make one for a brand, a campaign or an audience, and AI work can be done in it.'
            : ''}
        </p>
      ) : (
        <Catalog aria-label="AI projects" className="border-t">
          {ordered.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              actions={actions.data ?? []}
              schedules={schedules.data ?? []}
              directory={directory}
              canManage={canManage}
              canAdmin={canAdmin}
              busy={busy === p.id}
              inUse={inUse?.id === p.id ? inUse.use : null}
              onOpen={() => setEditing({ id: p.id })}
              onDefault={(on) => void setDefault(p, on)}
              onDelete={() => void remove(p)}
              onDismissInUse={() => setInUse(null)}
            />
          ))}
        </Catalog>
      )}
      <ProjectSheet
        client={client}
        editing={editing}
        canManage={canManage}
        canAdmin={canAdmin}
        canWrite={scopes.includes(SCOPES.contentWrite)}
        onClose={() => setEditing(null)}
        onSaved={(p, created) => {
          void refresh();
          toast.success(created ? `Created “${p.name}”` : `Saved “${p.name}”`);
          if (created) setEditing({ id: p.id });
        }}
      />
    </Section>
  );
}

/** "Used by 2 AI actions and 1 agent schedule", or nothing when nothing names it. */
function usedByLine(
  id: string,
  actions: readonly AIAction[],
  schedules: readonly AgentScheduleSummary[],
): string | null {
  const a = actions.filter((x) => x.projectId === id).length;
  const s = schedules.filter((x) => x.projectId === id).length;
  const parts = [
    ...(a ? [plural(a, 'AI action')] : []),
    ...(s ? [plural(s, 'agent schedule')] : []),
  ];
  return parts.length ? `Used by ${parts.join(' and ')}` : null;
}

function ProjectRow(props: {
  project: AiProjectSummary;
  actions: readonly AIAction[];
  schedules: readonly AgentScheduleSummary[];
  directory: ActorDirectory;
  canManage: boolean;
  canAdmin: boolean;
  busy: boolean;
  inUse: AiProjectInUse | null;
  onOpen: () => void;
  onDefault: (on: boolean) => void;
  onDelete: () => void;
  onDismissInUse: () => void;
}) {
  const { project: p, canManage, canAdmin } = props;
  // The default is space:admin's to change or delete; other projects content:manage's.
  const editable = p.isDefault ? canAdmin : canManage;
  const used = usedByLine(p.id, props.actions, props.schedules);
  const refs = p.references.length;
  return (
    <>
      <CatalogRow
        media={<CatalogTile aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</CatalogTile>}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="hit-area text-left font-medium underline-offset-2 hover:underline focus-visible:underline"
              onClick={props.onOpen}
              aria-label={`${editable ? 'Edit' : 'View'} ${p.name}`}
            >
              {p.name}
            </button>
            {p.isDefault ? <Badge variant="outline">Default</Badge> : null}
          </span>
        }
        meta={
          <span className="flex flex-col gap-0.5">
            {p.description ? <span className="max-w-measure">{p.description}</span> : null}
            <span className="flex flex-wrap gap-x-2">
              <span>{refs === 0 ? 'No references' : plural(refs, 'reference')}</span>
              {used ? <span>· {used}</span> : null}
              <span>
                · Updated by {actorLabel(p.updatedBy, props.directory, 'inSentence')}{' '}
                <Ago at={p.updatedAt} />
              </span>
            </span>
          </span>
        }
        actions={
          <span className="flex flex-wrap items-center justify-end gap-1 pointer-coarse:gap-5">
            {canAdmin ? (
              p.isDefault ? (
                <ConfirmButton
                  message={`Stop using “${p.name}” as the default?`}
                  note="AI work that names no project will then use none."
                  confirmLabel="Stop using as default"
                  tone="default"
                  busy={props.busy}
                  onConfirm={() => props.onDefault(false)}
                >
                  {(ask) => (
                    <Button type="button" variant="ghost" size="sm" onClick={ask}>
                      Clear default
                    </Button>
                  )}
                </ConfirmButton>
              ) : (
                <ConfirmButton
                  message={`Make “${p.name}” the default project?`}
                  note="Every AI call in this environment that names no project will work in it."
                  confirmLabel="Set as default"
                  tone="default"
                  busy={props.busy}
                  onConfirm={() => props.onDefault(true)}
                >
                  {(ask) => (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={ask}
                      aria-label={`Set as default: ${p.name}`}
                    >
                      Set as default
                    </Button>
                  )}
                </ConfirmButton>
              )
            ) : null}
            {editable ? (
              <ConfirmButton
                message={`Delete “${p.name}”?`}
                note={
                  p.isDefault
                    ? 'It’s the default: AI work that names no project will use none. This can’t be undone.'
                    : 'This can’t be undone.'
                }
                confirmLabel="Delete project"
                busy={props.busy}
                onConfirm={props.onDelete}
              >
                {(ask) => (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={ask}
                    aria-label={`Delete ${p.name}`}
                  >
                    Delete
                  </Button>
                )}
              </ConfirmButton>
            ) : null}
          </span>
        }
      />
      {props.inUse ? (
        <li className="px-(--card-spacing) pb-3">
          <InUseAlert
            name={p.name}
            use={props.inUse}
            actions={props.actions}
            schedules={props.schedules}
            onDismiss={props.onDismissInUse}
          />
        </li>
      ) : null}
    </>
  );
}

/** A refused delete (409 `project_in_use`): what still names the project, to point elsewhere. */
function InUseAlert(props: {
  name: string;
  use: AiProjectInUse;
  actions: readonly AIAction[];
  schedules: readonly AgentScheduleSummary[];
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const actionName = (id: string) => props.actions.find((a) => a.id === id)?.name;
  const schedule = (id: string) => props.schedules.find((s) => s.id === id);
  return (
    <Alert ref={ref} tabIndex={-1} variant="warning" className="outline-none">
      <AlertTitle className="line-clamp-none">“{props.name}” is still in use</AlertTitle>
      <AlertDescription>
        <p>
          Point these at another project first, or at none; then delete it. Nothing was deleted.
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {props.use.aiActions.map((id) => (
            <li key={id}>
              AI action{' '}
              {actionName(id) ? `“${actionName(id)}”` : <span className="font-mono">{id}</span>}
            </li>
          ))}
          {props.use.agentSchedules.map((id) => {
            const s = schedule(id);
            return (
              <li key={id}>
                Agent schedule{' '}
                {s ? (
                  <>
                    {s.workflow} <span className="font-mono">{s.cron}</span>
                  </>
                ) : (
                  <span className="font-mono">{id}</span>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mt-2 flex flex-wrap gap-2">
          {props.use.aiActions.length > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/settings/ai-actions">Open AI actions</Link>
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={props.onDismiss}>
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** A refused stale save: the version stored now. */
interface Stale {
  readonly version: number;
}

/**
 * A project's editor, in a sheet: its parts and its references, saved together with one Save held
 * to the version read. A save someone beat keeps the edits and offers to load theirs. Read-only
 * without content:manage, and for the default project without space:admin, saying why.
 */
function ProjectSheet(props: {
  client: ManagementClient;
  editing: Editing | null;
  canManage: boolean;
  canAdmin: boolean;
  /** content:write: what Retry takes, read-only or not. */
  canWrite: boolean;
  onClose: () => void;
  onSaved: (project: AiProjectView, created: boolean) => void;
}) {
  const { client, editing } = props;
  const id = editing && editing !== 'new' ? editing.id : null;
  const read = useScopedQuery(['ai-project', id], () => client.getAiProject(id as string), {
    enabled: id !== null,
    silent: true,
  });
  const [base, setBase] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY_DRAFT);
  const [view, setView] = useState<AiProjectView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState<Stale>();
  const [error, setError] = useState<string>();
  const [issues, setIssues] = useState<Record<string, string>>({});
  const staleRef = useRef<HTMLButtonElement>(null);

  // A new sheet, or the project read: the form starts from it. A refetch never replaces edits.
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (editing === null) {
      // Closed: the next project opens on its own loading state, never this one's form.
      seeded.current = null;
      setView(null);
      setBase(EMPTY_DRAFT);
      setDraft(EMPTY_DRAFT);
      setStale(undefined);
      setError(undefined);
      setIssues({});
      return;
    }
    const key = editing === 'new' ? 'new' : `${editing.id}`;
    if (editing === 'new') {
      if (seeded.current !== key) {
        seeded.current = key;
        setBase(EMPTY_DRAFT);
        setDraft(EMPTY_DRAFT);
        setView(null);
        setStale(undefined);
        setError(undefined);
        setIssues({});
      }
      return;
    }
    const data = read.data;
    if (!data) return;
    if (seeded.current === key && view && data.version <= view.version) return;
    if (seeded.current === key && draftChanged(base, draft)) {
      // Statuses still move on (a reference being read): keep the edits, show the news.
      setView((v) => (v ? { ...v, references: data.references } : v));
      return;
    }
    seeded.current = key;
    const d = draftOfProject(data);
    setBase(d);
    setDraft(d);
    setView(data);
    setStale(undefined);
    setError(undefined);
    setIssues({});
  }, [editing, read.data, view, base, draft]);

  useEffect(() => {
    if (stale) staleRef.current?.focus();
  }, [stale]);

  const isDefault = view?.isDefault === true;
  const readOnly = isDefault ? !props.canAdmin : !props.canManage;
  const dirty = draftChanged(base, draft);
  const over = instructionsLength(draft.instructions).over;
  const guard = useDiscardGuard({
    open: editing !== null,
    dirty: dirty && !readOnly,
    saving: busy,
    subject: id,
    onOpenChange: (o) => {
      if (!o) props.onClose();
    },
  });

  const save = async () => {
    if (readOnly || busy || over) return;
    setBusy(true);
    setError(undefined);
    setIssues({});
    try {
      if (editing === 'new') {
        const created = await client.createAiProject(inputOf(draft));
        const d = draftOfProject(created);
        seeded.current = created.id;
        setBase(d);
        setDraft(d);
        setView(created);
        props.onSaved(created, true);
      } else if (view) {
        const res = await client.updateAiProject(view.id, {
          ...inputOf(draft),
          expectedVersion: view.version,
        });
        const d = draftOfProject(res.project);
        setBase(d);
        setDraft(d);
        setView(res.project);
        props.onSaved(res.project, false);
      }
    } catch (err) {
      const theirs = conflictVersion(err);
      if (theirs !== undefined && editing !== 'new') setStale({ version: theirs });
      else {
        setIssues(apiFieldIssues(err));
        setError(guard.saveFailed(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const loadLatest = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const latest = await client.getAiProject(id);
      const d = draftOfProject(latest);
      setBase(d);
      setDraft(d);
      setView(latest);
      setStale(undefined);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const set = (next: Partial<ProjectDraft>) => setDraft((d) => ({ ...d, ...next }));
  const title =
    editing === 'new'
      ? 'New AI project'
      : readOnly
        ? (view?.name ?? 'AI project')
        : 'Edit AI project';

  return (
    <Sheet open={editing !== null} onOpenChange={guard.onOpenChange}>
      <ResponsiveSheetContent className="sm:max-w-xl" bodyClassName="gap-0">
        <SheetHeader className="gap-1 border-b pt-4 pb-3">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="text-xs">
            What it says shapes tone, wording and audience. It can’t change what a feature does, the
            tools it may use, or what it returns; the space’s guidance wins where they differ.
          </SheetDescription>
        </SheetHeader>
        {editing !== 'new' && !view ? (
          <div className="p-4" aria-busy={!read.isError || undefined}>
            {read.isError ? (
              <Alert variant="destructive">
                <AlertTitle>The project didn’t load</AlertTitle>
                <AlertDescription>
                  <p>{apiErrorMessage(read.error)}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => void read.refetch()}
                  >
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <LoadingStatus>Loading the project…</LoadingStatus>
                <SkeletonText width="14rem" />
              </>
            )}
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="cw-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
              {readOnly ? (
                <Alert variant="warning">
                  <AlertTitle className="line-clamp-none">Read-only</AlertTitle>
                  <AlertDescription>
                    {isDefault
                      ? 'This is the default project: it reaches everyone’s AI work, so only a space administrator (space:admin) can change it.'
                      : 'Changing AI projects takes the content:manage scope.'}
                  </AlertDescription>
                </Alert>
              ) : null}
              <ProjectFields
                draft={draft}
                issues={issues}
                disabled={readOnly || busy}
                onChange={set}
              />
              <References
                client={client}
                draft={draft}
                view={view}
                disabled={readOnly || busy}
                canRetry={props.canWrite && !busy}
                onChange={(references) => set({ references })}
                onStatus={(status) =>
                  setView((v) =>
                    v
                      ? {
                          ...v,
                          references: v.references.map((r) =>
                            r.assetId === status.assetId ? status : r,
                          ),
                        }
                      : v,
                  )
                }
              />
              {stale ? (
                <Alert variant="warning">
                  <AlertTitle className="line-clamp-none">
                    This project changed since you opened it
                  </AlertTitle>
                  <AlertDescription>
                    <p>
                      {guard.unconfirmed
                        ? `It’s at v${stale.version} now: that may be your own save that didn’t confirm, or someone else’s. Your changes here weren’t saved.`
                        : `Someone else saved it as v${stale.version}, so your changes weren’t saved: saving them would undo theirs.`}{' '}
                      Load the latest to edit it (your changes here are discarded), or copy your
                      version first.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <CopyButton
                        text={JSON.stringify(inputOf(draft), null, 2)}
                        label="Copy my version as JSON"
                      />
                      <Button
                        ref={staleRef}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={loading}
                        onClick={() => void loadLatest()}
                      >
                        {loading ? 'Loading…' : 'Load the latest'}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {error ? (
                <Alert variant="destructive">
                  <AlertTitle className="line-clamp-none">
                    {editing === 'new'
                      ? 'The project wasn’t created'
                      : 'Your changes weren’t saved'}
                  </AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t p-4">
              {readOnly ? (
                <Button type="button" variant="outline" onClick={props.onClose}>
                  Close
                </Button>
              ) : (
                <DiscardAsk
                  guard={guard}
                  message={
                    editing === 'new' ? 'Discard this project?' : 'Discard your changes to it?'
                  }
                >
                  <p className="mr-auto text-muted-foreground text-sm" aria-live="polite">
                    {over ? 'Shorten the instructions to save.' : dirty ? 'Unsaved changes' : ''}
                  </p>
                  <GuardCancel guard={guard} />
                  <Button
                    type="submit"
                    disabled={!dirty || over || busy || stale !== undefined || !draft.name.trim()}
                  >
                    {busy ? 'Saving…' : editing === 'new' ? 'Create project' : 'Save'}
                  </Button>
                </DiscardAsk>
              )}
            </div>
          </form>
        )}
      </ResponsiveSheetContent>
    </Sheet>
  );
}

/** A count under a field: "120 of 4,000 characters", red once over. */
function CharCount(props: { id: string; chars: number; max: number }) {
  const over = props.chars > props.max;
  return (
    <p
      id={props.id}
      className={over ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
    >
      {count.format(props.chars)} of {count.format(props.max)} characters
      {over ? ': shorten it to save.' : ''}
    </p>
  );
}

function ProjectFields(props: {
  draft: ProjectDraft;
  issues: Record<string, string>;
  disabled: boolean;
  onChange: (next: Partial<ProjectDraft>) => void;
}) {
  const { draft, issues, disabled, onChange } = props;
  const id = useId();
  const instructions = instructionsLength(draft.instructions);
  const issue = (field: string) =>
    issues[field] ? (
      <p id={`${id}-${field}-issue`} className="text-destructive text-xs">
        {issues[field]}
      </p>
    ) : null;
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={draft.name}
          maxLength={AI_PROJECT_NAME_MAX}
          disabled={disabled}
          placeholder="Northwind launch"
          aria-invalid={issues.name ? true : undefined}
          aria-describedby={issues.name ? `${id}-name-issue` : undefined}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        {issue('name')}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-description`}>Description</Label>
        <Textarea
          id={`${id}-description`}
          rows={2}
          value={draft.description}
          maxLength={AI_PROJECT_DESCRIPTION_MAX}
          disabled={disabled}
          aria-describedby={`${id}-description-hint`}
          onChange={(e) => onChange({ description: e.target.value })}
        />
        <p id={`${id}-description-hint`} className="text-muted-foreground text-xs">
          Shown in the project pickers. It is never sent to a model.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-instructions`}>Instructions</Label>
        <Textarea
          id={`${id}-instructions`}
          rows={5}
          value={draft.instructions}
          disabled={disabled}
          placeholder="What to do and avoid, terms to use, facts to prefer."
          aria-invalid={instructions.over || undefined}
          aria-describedby={`${id}-instructions-count`}
          onChange={(e) => onChange({ instructions: e.target.value })}
        />
        <CharCount
          id={`${id}-instructions-count`}
          chars={instructions.chars}
          max={AI_PROJECT_INSTRUCTIONS_MAX}
        />
        {/* Said once, as it crosses the limit, not on every keystroke. */}
        <p className="sr-only" role="status">
          {instructions.over
            ? `The instructions are over ${count.format(AI_PROJECT_INSTRUCTIONS_MAX)} characters`
            : ''}
        </p>
      </div>
      <PersonaFields
        legend="Writer"
        hint="Who is writing, and in what voice."
        name={draft.writerName}
        description={draft.writerDescription}
        disabled={disabled}
        issues={{ name: issues['writer.name'], description: issues['writer.description'] }}
        onChange={(name, description) =>
          onChange({ writerName: name, writerDescription: description })
        }
      />
      <PersonaFields
        legend="Reader"
        hint="Who it is for: what they know, care about and how they read."
        name={draft.readerName}
        description={draft.readerDescription}
        disabled={disabled}
        issues={{ name: issues['reader.name'], description: issues['reader.description'] }}
        onChange={(name, description) =>
          onChange({ readerName: name, readerDescription: description })
        }
      />
    </>
  );
}

/** A persona: a name and a description, both or neither. */
function PersonaFields(props: {
  legend: string;
  hint: string;
  name: string;
  description: string;
  disabled: boolean;
  issues: { name?: string; description?: string };
  onChange: (name: string, description: string) => void;
}) {
  const id = useId();
  return (
    <fieldset className="space-y-2" aria-describedby={`${id}-hint`}>
      <legend className="font-medium text-sm">{props.legend}</legend>
      <p id={`${id}-hint`} className="text-muted-foreground text-xs">
        {props.hint} Leave both blank for none.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-name`}>{props.legend} name</Label>
        <Input
          id={`${id}-name`}
          value={props.name}
          maxLength={AI_PERSONA_NAME_MAX}
          disabled={props.disabled}
          aria-invalid={props.issues.name ? true : undefined}
          aria-describedby={props.issues.name ? `${id}-name-issue` : undefined}
          onChange={(e) => props.onChange(e.target.value, props.description)}
        />
        {props.issues.name ? (
          <p id={`${id}-name-issue`} className="text-destructive text-xs">
            {props.issues.name}
          </p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-description`}>{props.legend} description</Label>
        <Textarea
          id={`${id}-description`}
          rows={3}
          value={props.description}
          maxLength={AI_PERSONA_DESCRIPTION_MAX}
          disabled={props.disabled}
          aria-invalid={props.issues.description ? true : undefined}
          aria-describedby={props.issues.description ? `${id}-description-issue` : undefined}
          onChange={(e) => props.onChange(props.name, e.target.value)}
        />
        {props.issues.description ? (
          <p id={`${id}-description-issue`} className="text-destructive text-xs">
            {props.issues.description}
          </p>
        ) : null}
      </div>
    </fieldset>
  );
}

/** A document or a recording: what a reference may be. */
const isReferenceable = (a: Asset) =>
  a.status !== 'archived' && ['document', 'audio'].includes(assetKind(a.file.contentType));

const assetLabel = (a: Asset, locale: string) =>
  String(a.title?.[locale] ?? Object.values(a.title ?? {})[0] ?? a.file.fileName);

/**
 * The project's references, in order of importance: each with its pinned file and its text status
 * from the API, the way on that status allows (Retry, Use the new file, Remove), and a picker over
 * the library's documents and recordings to add more.
 */
function References(props: {
  client: ManagementClient;
  draft: ProjectDraft;
  view: AiProjectView | null;
  disabled: boolean;
  canRetry: boolean;
  onChange: (references: readonly DraftReference[]) => void;
  onStatus: (status: AiReferenceStatus) => void;
}) {
  const { client, draft, view, disabled } = props;
  const { conn } = useClient();
  const toast = useToast();
  const id = useId();
  const mediaOn = useAiCapability('media');
  const settings = useScopedQuery(AI_SETTINGS_KEY, () => client.getAiSettings(), {
    silent: true,
    staleTime: 60_000,
  });
  const mediaOff = settings.data ? !settings.data.capabilities.media.enabled : false;
  const ids = draft.references.map((r) => r.assetId);
  // The files the references name, for their titles, kinds and current versions.
  const named = useScopedQuery(
    ['ai-project-assets', ...ids],
    async () =>
      ids.length ? (await client.listAssets({ ids, limit: 100, status: 'all' })).items : [],
    { silent: true, keepPrevious: true },
  );
  const byId = new Map((named.data ?? []).map((a) => [a.id, a]));
  // What the picker offers before anyone types: the newest documents and recordings.
  const seed = useScopedQuery(
    ['ai-project-pickable'],
    async () => {
      const [docs, audio] = await Promise.all([
        client.listAssets({ kind: 'document', limit: 50 }),
        client.listAssets({ kind: 'audio', limit: 50 }),
      ]);
      return [...docs.items, ...audio.items];
    },
    { silent: true, enabled: !disabled },
  );
  const [picked, setPicked] = useState<Asset[]>([]);
  const known = (aid: string) => byId.get(aid) ?? picked.find((a) => a.id === aid);
  const toOption = (a: Asset): PickOption => ({
    id: a.id,
    label: assetLabel(a, conn.locale),
    mimeType: a.file.contentType,
  });
  const options = (seed.data ?? [])
    .filter((a) => isReferenceable(a) && !ids.includes(a.id))
    .map(toOption);
  const search = async (q: string): Promise<PickOption[]> => {
    if (!q) return options;
    const [docs, audio] = await Promise.all([
      client.searchAssets({ q, kind: 'document', limit: 20 }),
      client.searchAssets({ q, kind: 'audio', limit: 20 }),
    ]);
    const hits = [...docs.items, ...audio.items].filter(
      (a) => isReferenceable(a) && !ids.includes(a.id),
    );
    setPicked((p) => [...p, ...hits.filter((h) => !p.some((x) => x.id === h.id))]);
    return hits.map(toOption);
  };
  const full = draft.references.length >= AI_PROJECT_MAX_REFERENCES;
  const [retrying, setRetrying] = useState<string | null>(null);

  const move = (from: number, to: number) => {
    const next = [...draft.references];
    const [r] = next.splice(from, 1);
    if (r) next.splice(to, 0, r);
    props.onChange(next);
  };
  const retry = async (assetId: string) => {
    if (!view) return;
    setRetrying(assetId);
    try {
      const r = await client.extractAiProjectReference(view.id, assetId);
      props.onStatus(r.status);
      toast.success('Reading the file’s text again');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <fieldset className="space-y-2" aria-describedby={`${id}-hint`}>
      <legend className="font-medium text-sm">References</legend>
      <p id={`${id}-hint`} className="max-w-measure text-muted-foreground text-xs">
        Documents and recordings from the asset library, most important first (up to{' '}
        {AI_PROJECT_MAX_REFERENCES}). Each is pinned to the file it is now: a newer file changes
        nothing until you move to it. The first three are excerpted into each call.
      </p>
      {draft.references.length === 0 ? (
        <p className="text-muted-foreground text-sm">No references.</p>
      ) : (
        <ol className="divide-y rounded-2xl border" aria-label="References">
          {draft.references.map((r, i) => {
            const asset = known(r.assetId);
            const status = view?.references.find(
              (s) => s.assetId === r.assetId && s.version === r.version,
            );
            const name = asset ? assetLabel(asset, conn.locale) : 'A file you can’t see';
            return (
              <ReferenceRow
                key={r.assetId}
                index={i}
                total={draft.references.length}
                name={name}
                asset={asset}
                reference={r}
                status={status}
                movedTo={
                  view?.references.find((s) => s.assetId === r.assetId)?.version !== r.version
                    ? r.version
                    : undefined
                }
                disabled={disabled}
                mediaOn={mediaOn}
                mediaOff={mediaOff}
                canRetry={props.canRetry}
                retrying={retrying === r.assetId}
                onRetry={() => void retry(r.assetId)}
                onUseNew={() => {
                  const current = asset?.version ?? 1;
                  props.onChange(
                    draft.references.map((x) =>
                      x.assetId === r.assetId ? { ...x, version: current } : x,
                    ),
                  );
                }}
                onUp={() => move(i, i - 1)}
                onDown={() => move(i, i + 1)}
                onRemove={() =>
                  props.onChange(draft.references.filter((x) => x.assetId !== r.assetId))
                }
              />
            );
          })}
        </ol>
      )}
      {disabled ? null : (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-add`}>Add a reference</Label>
          {full ? (
            <p className="text-muted-foreground text-sm">
              A project has at most {AI_PROJECT_MAX_REFERENCES} references. Remove one to add
              another.
            </p>
          ) : (
            <EntityPicker
              id={`${id}-add`}
              options={options}
              value=""
              placeholder="Search documents and recordings…"
              onSearch={search}
              onChange={(assetId) => {
                if (!assetId) return;
                const asset =
                  (seed.data ?? []).find((a) => a.id === assetId) ??
                  picked.find((a) => a.id === assetId);
                if (asset) setPicked((p) => (p.some((x) => x.id === asset.id) ? p : [...p, asset]));
                props.onChange([...draft.references, { assetId }]);
              }}
            />
          )}
          <p className="max-w-measure text-muted-foreground text-xs">
            A file without text yet will be read by a model the first time the project is used
            {mediaOff ? ', but Media is off in Settings → AI, so none is read until it’s on' : ''}.
          </p>
        </div>
      )}
    </fieldset>
  );
}

function ReferenceRow(props: {
  index: number;
  total: number;
  name: string;
  asset: Asset | undefined;
  reference: DraftReference;
  status: AiReferenceStatus | undefined;
  /** The pin moved in this form (Use the new file), not yet saved: the file version it moves to. */
  movedTo: number | undefined;
  disabled: boolean;
  mediaOn: boolean;
  mediaOff: boolean;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
  onUseNew: () => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const { status, asset, reference: r, name } = props;
  const audio = asset ? assetKind(asset.file.contentType) === 'audio' : false;
  const Icon = audio ? FileAudio : FileText;
  const unsaved = !status;
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <div className="flex min-w-0 items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm" title={name}>
            {props.index + 1}. {name}
          </p>
          <p className="text-muted-foreground text-xs">
            {r.version === undefined
              ? 'Pinned to the current file when you save'
              : props.movedTo !== undefined
                ? `Moves to file version ${r.version} when you save`
                : `File version ${r.version}`}
          </p>
        </div>
        {props.disabled ? null : (
          <span className="flex shrink-0 items-center pointer-coarse:gap-5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={props.index === 0}
              aria-label={`Move ${name} up`}
              onClick={props.onUp}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={props.index === props.total - 1}
              aria-label={`Move ${name} down`}
              onClick={props.onDown}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${name}`}
              onClick={props.onRemove}
            >
              <X aria-hidden="true" />
            </Button>
          </span>
        )}
      </div>
      {unsaved ? (
        <p className="text-muted-foreground text-xs">
          Not saved yet. This file will be read by a model the first time the project is used
          {props.mediaOff ? ', but Media is off in Settings → AI' : ''}.
        </p>
      ) : (
        <ReferenceStatus
          name={name}
          status={status}
          mediaOn={props.mediaOn}
          mediaOff={props.mediaOff}
          canRetry={props.canRetry}
          retrying={props.retrying}
          canMove={!props.disabled && props.movedTo === undefined && asset !== undefined}
          onRetry={props.onRetry}
          onUseNew={props.onUseNew}
        />
      )}
    </li>
  );
}

/** A reference's text status, as the API reported it, and what can be done about it. */
function ReferenceStatus(props: {
  name: string;
  status: AiReferenceStatus;
  mediaOn: boolean;
  mediaOff: boolean;
  canRetry: boolean;
  retrying: boolean;
  canMove: boolean;
  onRetry: () => void;
  onUseNew: () => void;
}) {
  const { status: s } = props;
  // The API says whether it would take one (`retryable`): the screen holds no rule of its own.
  const retry = props.canRetry && s.retryable === true;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs">
      {s.gone ? (
        <>
          <ToneBadge tone="bad" label="Gone" />
          <span className="text-muted-foreground">
            The file was deleted or archived: it reaches no prompt. Remove it.
          </span>
        </>
      ) : s.text === 'ready' ? (
        <>
          <ToneBadge tone="ok" label="Ready" />
          <span className="text-muted-foreground">
            {s.textBytes !== undefined ? `${fileSize(s.textBytes)} of text` : 'Its text is read'}
          </span>
        </>
      ) : s.text === 'pending' ? (
        <>
          <ToneBadge tone="run" label="Being read" />
          <span className="text-muted-foreground">Its text isn’t ready yet.</span>
        </>
      ) : (
        <>
          <ToneBadge tone={s.reason === 'not_extracted' ? 'idle' : 'wait'} label="No text" />
          <span className="text-muted-foreground">
            {s.reason ? NO_TEXT_REASON[s.reason] : 'It has no text.'}
            {s.reason === 'not_extracted' && props.mediaOff
              ? ' Media is off in Settings → AI, so it won’t be read until it’s on.'
              : ''}
            {s.reason === 'media_off' && !props.mediaOn ? ' Turn Media on in Settings → AI.' : ''}
          </span>
          {retry ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={props.retrying}
              aria-label={`Retry reading ${props.name}`}
              onClick={props.onRetry}
            >
              {props.retrying ? 'Retrying…' : 'Retry'}
            </Button>
          ) : null}
        </>
      )}
      {s.updateAvailable && !s.gone ? (
        <span className="flex basis-full flex-wrap items-center gap-2">
          <ToneBadge tone="wait" label="Update available" />
          <span className="text-muted-foreground">The asset has a newer file.</span>
          {props.canMove ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label={`Use the new file for ${props.name}`}
              onClick={props.onUseNew}
            >
              Use the new file
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
