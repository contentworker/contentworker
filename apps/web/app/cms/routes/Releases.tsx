import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@contentworker/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentworker/ui/dialog';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@contentworker/ui/sheet';
import { Skeleton } from '@contentworker/ui/skeleton';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@contentworker/ui/tabs';
import { CalendarClock, PackageOpen, Plus, Rocket, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { EmptyState, PageHeader } from '~/cms/components/page';
import { ReleasePublishConfirm } from '~/cms/components/ReleasePublishConfirm';
import { StatusBadge } from '~/cms/components/status';
import { useClient } from '../lib/client-context';
import { useAllEntriesQuery, useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

/** Local datetime → ISO, defaulting to one hour out for the picker initial value. */
function defaultScheduleLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  // datetime-local wants `YYYY-MM-DDTHH:mm` in local time.
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/** Releases board + scheduled-actions queue — the P12 editorial surface. */
export function Releases() {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  // At most one card asks "are you sure?" at a time, in place of its footer.
  const [confirming, setConfirming] = useState<{
    kind: 'publish' | 'delete';
    id: string;
  } | null>(null);
  const triggerId = (kind: 'publish' | 'delete', id: string) => `release-${kind}-${id}`;
  // Back to the trigger after a cancel. After a confirm the trigger is disabled
  // while the request runs (and gone once published), and focus() on it would
  // drop focus to <body> — so fall back to the card's Open button.
  const focusTrigger = (kind: 'publish' | 'delete', id: string) => () => {
    const trigger = document.getElementById(triggerId(kind, id));
    return trigger instanceof HTMLButtonElement && !trigger.disabled
      ? trigger
      : document.getElementById(`release-open-${id}`);
  };

  const releasesQuery = useScopedQuery(['releases'], () => client.listReleases());
  const scheduledQuery = useScopedQuery(['scheduled-actions'], () => client.listScheduledActions());
  const releases = releasesQuery.data ?? [];
  const scheduled = scheduledQuery.data ?? [];
  const loading = releasesQuery.isPending || scheduledQuery.isPending;

  // Publishing a release publishes its entries, so entry lists/details go
  // stale too; the entries invalidations are cheap no-ops when unmounted.
  // The 'release' prefix covers every detail sheet's cache — without it a
  // just-published release could reopen as still-editable within staleTime.
  const reload = () =>
    invalidate(['releases'], ['scheduled-actions'], ['release'], ['entries'], ['entry']);

  const publishNow = (id: string) =>
    run(async () => {
      await client.publishRelease(id);
      toast.success('Release published');
      await reload();
    });

  const remove = (id: string) =>
    run(async () => {
      await client.deleteRelease(id);
      toast.success('Release deleted');
      if (openId === id) setOpenId(null);
      await reload();
    });

  const cancel = (id: string) =>
    run(async () => {
      await client.cancelScheduledAction(id);
      toast.success('Scheduled action canceled');
      await reload();
    });

  const pendingCount = scheduled.filter((a) => a.status === 'pending').length;

  return (
    <div className="space-y-4">
      <PageHeader title="Releases" subtitle="Bundle entries and ship them atomically.">
        <Button type="button" size="sm" onClick={() => setCreating(true)} disabled={busy}>
          <Plus aria-hidden="true" /> New release
        </Button>
      </PageHeader>

      <Tabs defaultValue="releases">
        <TabsList>
          <TabsTrigger value="releases">Releases</TabsTrigger>
          <TabsTrigger value="scheduled">
            Scheduled
            {pendingCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="releases" className="mt-4">
          {loading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-40 w-full" />
              ))}
            </div>
          ) : releases.length === 0 ? (
            <EmptyState
              icon={PackageOpen}
              title="No releases yet"
              description="Group entries into a release to publish them together at one moment."
            >
              <Button type="button" onClick={() => setCreating(true)}>
                Create release
              </Button>
            </EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {releases.map((r) => (
                <Card key={r.id} className="flex flex-col">
                  <CardHeader>
                    <CardTitle className="section-title break-words">
                      <h2>{r.title}</h2>
                    </CardTitle>
                    {r.description && (
                      <CardDescription className="line-clamp-2">{r.description}</CardDescription>
                    )}
                    <CardAction>
                      <StatusBadge status={r.status} />
                    </CardAction>
                  </CardHeader>
                  <CardContent className="flex-1 text-muted-foreground text-sm">
                    Created {fmt(r.createdAt)}
                    {r.publishedAt && <div>Published {fmt(r.publishedAt)}</div>}
                  </CardContent>
                  {confirming?.id === r.id ? (
                    <CardFooter>
                      {confirming.kind === 'publish' ? (
                        <ReleasePublishConfirm
                          releaseId={r.id}
                          releaseTitle={r.title}
                          busy={busy}
                          onCancel={() => setConfirming(null)}
                          returnFocus={focusTrigger('publish', r.id)}
                          onConfirm={() => {
                            setConfirming(null);
                            void publishNow(r.id);
                          }}
                        />
                      ) : (
                        <InlineConfirm
                          message={`Delete “${r.title}”?`}
                          note="Its entries stay as they are; the release itself can’t be recovered."
                          onCancel={() => setConfirming(null)}
                          returnFocus={focusTrigger('delete', r.id)}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => {
                              setConfirming(null);
                              void remove(r.id);
                            }}
                          >
                            Delete release
                          </Button>
                        </InlineConfirm>
                      )}
                    </CardFooter>
                  ) : (
                    <CardFooter className="gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        id={`release-open-${r.id}`}
                        onClick={() => setOpenId(r.id)}
                      >
                        Open
                      </Button>
                      {r.status === 'open' && (
                        <Button
                          id={triggerId('publish', r.id)}
                          type="button"
                          size="sm"
                          onClick={() => setConfirming({ kind: 'publish', id: r.id })}
                          disabled={busy}
                        >
                          <Rocket className="size-4" />
                          Publish
                        </Button>
                      )}
                      {r.status !== 'published' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="ml-auto size-8"
                          id={triggerId('delete', r.id)}
                          aria-label={`Delete “${r.title}”`}
                          onClick={() => setConfirming({ kind: 'delete', id: r.id })}
                          disabled={busy}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </CardFooter>
                  )}
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="scheduled" className="mt-4">
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : scheduled.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="Nothing scheduled"
              description="Schedule a release or entry to publish automatically at a future time."
            />
          ) : (
            <div className="card overflow-clip">
              <Table stack="cards" caption="Scheduled publishes">
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>When</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-20">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scheduled.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium capitalize">{a.action}</TableCell>
                      <TableCell label="Target">
                        <span className="text-muted-foreground">{a.entityType}</span>{' '}
                        <code className="whitespace-nowrap font-mono text-xs">
                          {a.entityId.slice(0, 8)}
                        </code>
                      </TableCell>
                      <TableCell label="When">{fmt(a.scheduledFor)}</TableCell>
                      <TableCell label="Status">
                        <StatusBadge status={a.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {a.status === 'pending' && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => cancel(a.id)}
                            disabled={busy}
                          >
                            <X className="size-4" />
                            Cancel
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <CreateReleaseDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={(input) =>
          run(async () => {
            const created = await client.createRelease(input);
            setCreating(false);
            toast.success('Release created');
            await reload();
            setOpenId(created.id);
          })
        }
        busy={busy}
      />

      <ReleaseDetailSheet
        releaseId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => void reload()}
      />
    </div>
  );
}

function CreateReleaseDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { title: string; description?: string }) => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  // Reset fields each time the dialog opens.
  useEffect(() => {
    if (props.open) {
      setTitle('');
      setDescription('');
    }
  }, [props.open]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New release</DialogTitle>
          <DialogDescription>Name the release; add entries after creating it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="release-title">Title</Label>
            <Input
              id="release-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Spring campaign"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-desc">Description</Label>
            <Input
              id="release-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!title.trim() || props.busy}
            onClick={() =>
              props.onCreate({ title: title.trim(), description: description.trim() || undefined })
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Detail panel for one release: members, add/remove, publish, and scheduling. */
function ReleaseDetailSheet(props: {
  releaseId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  // The entry picker resets in-render whenever a different release is opened.
  const [pickState, setPickState] = useState({ releaseId: props.releaseId, id: '' });
  if (pickState.releaseId !== props.releaseId) {
    setPickState({ releaseId: props.releaseId, id: '' });
  }
  const pick = pickState.releaseId === props.releaseId ? pickState.id : '';
  const setPick = (id: string) => setPickState({ releaseId: props.releaseId, id });
  const [when, setWhen] = useState(defaultScheduleLocal);
  // Which release's publish is awaiting confirmation; keyed by id so opening
  // another release never inherits a half-answered confirm.
  const [askingFor, setAskingFor] = useState<string | null>(null);

  const detail =
    useScopedQuery(['release', props.releaseId], () => client.getRelease(props.releaseId ?? ''), {
      enabled: !!props.releaseId,
    }).data ?? null;
  const entries = useAllEntriesQuery({ enabled: !!props.releaseId }).data ?? [];

  const refresh = async () => {
    await invalidate(['release', props.releaseId]);
    props.onChanged();
  };

  const id = props.releaseId;
  const open = !!id;
  const release = detail?.release;
  const items = detail?.items ?? [];
  const memberIds = new Set(items.map((i) => i.entityId));
  const candidates = entries.filter((e) => !memberIds.has(e.id));
  const editable = release?.status === 'open';
  const asking = !!id && askingFor === id;

  const addEntry = () =>
    run(async () => {
      if (!id || !pick) return;
      await client.addEntryToRelease(id, { entityId: pick });
      setPick('');
      toast.success('Entry added');
      await refresh();
    });

  const removeEntry = (entityId: string) =>
    run(async () => {
      if (!id) return;
      await client.removeEntryFromRelease(id, entityId);
      await refresh();
    });

  const publishNow = () =>
    run(async () => {
      if (!id) return;
      await client.publishRelease(id);
      toast.success('Release published');
      props.onClose();
      props.onChanged();
    });

  const schedule = () =>
    run(async () => {
      if (!id) return;
      await client.scheduleAction({
        action: 'publish',
        entityType: 'Release',
        entityId: id,
        scheduledFor: new Date(when).toISOString(),
      });
      toast.success('Release scheduled');
      props.onClose();
      props.onChanged();
    });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && props.onClose()}>
      <SheetContent side="right" className="flex w-full flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{release?.title ?? 'Release'}</SheetTitle>
          <SheetDescription>
            {release
              ? `${items.length} member${items.length === 1 ? '' : 's'} · ${release.status}`
              : 'Loading…'}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          {editable && (
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>Add entry</Label>
                <Select value={pick} onValueChange={setPick}>
                  <SelectTrigger aria-label="Add entry">
                    <SelectValue placeholder="Pick an entry…" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No more entries
                      </SelectItem>
                    ) : (
                      candidates.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.contentType} · {e.id.slice(0, 8)} ({e.status})
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" onClick={addEntry} disabled={!pick || busy}>
                Add
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <Label>Members</Label>
            {items.length === 0 ? (
              <p className="text-muted-foreground text-sm">No entries in this release yet.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {items.map((it) => (
                  <li
                    key={it.entityId}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <code className="text-xs">{it.entityId.slice(0, 12)}</code>
                      <Badge variant="outline" className="ml-2 capitalize">
                        {it.action}
                      </Badge>
                    </div>
                    {editable && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Remove entry"
                        onClick={() => removeEntry(it.entityId)}
                        disabled={busy}
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {editable && (
            <div className="space-y-3 border-t pt-4">
              {asking && id ? (
                <ReleasePublishConfirm
                  releaseId={id}
                  releaseTitle={release?.title ?? 'this release'}
                  busy={busy}
                  onCancel={() => setAskingFor(null)}
                  returnFocus={() => document.getElementById('release-sheet-publish')}
                  onConfirm={() => {
                    setAskingFor(null);
                    void publishNow();
                  }}
                />
              ) : (
                <Button
                  id="release-sheet-publish"
                  type="button"
                  className="w-full"
                  onClick={() => setAskingFor(id)}
                  disabled={items.length === 0 || busy}
                >
                  <Rocket className="size-4" />
                  Publish now…
                </Button>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="schedule-when">Or schedule for</Label>
                <div className="flex gap-2">
                  <Input
                    id="schedule-when"
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={schedule}
                    disabled={items.length === 0 || !when || busy}
                  >
                    <CalendarClock className="size-4" />
                    Schedule
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
