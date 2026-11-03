import { type ContentType, isValidApiId } from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Checkbox } from '@contentworker/ui/checkbox';
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
import { SkeletonText } from '@contentworker/ui/skeleton';
import { useState } from 'react';
import { LoadingStatus } from '~/cms/components/loading';
import { toApiId } from '../lib/api-id';
import { useClient } from '../lib/client-context';
import { plural } from '../lib/format';
import type { BulkJobSummary, ContentTypeDependents } from '../lib/management';
import { useScopedQuery } from '../lib/queries';

/**
 * Copies a content type under a new name and API ID: its fields, display field and singleton
 * flag, as a draft with no entries. Not its URL pattern, which would route the same paths twice.
 */
export function CloneContentTypeDialog(props: {
  source: ContentType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloned: (clone: ContentType) => void;
}) {
  const { client } = useClient();
  const [name, setName] = useState(`${props.source.name} copy`);
  const [apiId, setApiId] = useState(toApiId(`${props.source.name} copy`));
  const [apiIdTouched, setApiIdTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (!name.trim() || !isValidApiId(apiId)) {
      setError('A name and a valid API ID (letter, then letters/numbers/_) are required.');
      return;
    }
    setBusy(true);
    try {
      const clone = await client.cloneContentType(props.source.apiId, {
        apiId,
        name: name.trim(),
      });
      props.onCloned(clone);
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clone “{props.source.name}”</DialogTitle>
          <DialogDescription>
            The copy has the same fields and display field, as a draft with no entries. Its URL
            pattern is left out, so the two never claim the same paths.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ct-clone-name">Name</Label>
            <Input
              id="ct-clone-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!apiIdTouched) setApiId(toApiId(e.target.value));
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ct-clone-apiid">API ID</Label>
            <Input
              id="ct-clone-apiid"
              value={apiId}
              className="font-mono"
              onChange={(e) => {
                setApiIdTouched(true);
                setApiId(e.target.value);
              }}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Cloning…' : 'Clone content type'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What blocks a delete besides the entries, one line each, for the dialog. */
function otherBlockers(d: ContentTypeDependents): string[] {
  const lines: string[] = [];
  for (const f of d.linkedFrom) lines.push(`${f.contentType}.${f.field} links to it`);
  for (const m of d.menus) lines.push(`The menu “${m.handle}” links its entries`);
  for (const r of d.redirects)
    lines.push(`The redirect from ${r.source} points at one of its entries`);
  if (d.urlPattern) lines.push(`Its URL pattern ${d.urlPattern} is served as a site route`);
  return lines;
}

/**
 * Deletes a content type, confirmed by typing its API ID: there is no way back. It first reads
 * what depends on the type. Another type linking to it, a menu or redirect naming its entries, or
 * a URL pattern each blocks the delete, and the dialog names them. Entries (the trash included)
 * block it too, unless the person chooses to delete them with it: then a background job moves
 * each to the trash and deletes it permanently, and the type goes when they are all gone.
 */
export function DeleteContentTypeDialog(props: {
  type: ContentType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Deleted at once (null), or a job deleting its entries first. */
  onDeleted: (job: BulkJobSummary | null) => void;
}) {
  const { client } = useClient();
  const { apiId, name } = props.type;
  const deps = useScopedQuery(
    ['content-types', 'dependents', apiId],
    () => client.contentTypeDependents(apiId),
    { enabled: props.open, silent: true },
  );
  const [typed, setTyped] = useState('');
  const [withEntries, setWithEntries] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const d = deps.data;
  const entries = d ? d.entries.live + d.entries.trashed : 0;
  const blocked = d ? otherBlockers(d) : [];
  const ready =
    d !== undefined &&
    blocked.length === 0 &&
    (entries === 0 || withEntries) &&
    typed.trim() === apiId;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setError(undefined);
    setBusy(true);
    try {
      const done = await client.deleteContentType(apiId, { purgeEntries: entries > 0 });
      props.onDeleted(done.deleted ? null : done.job);
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete “{name}”?</DialogTitle>
          <DialogDescription>
            This deletes the content type’s definition. It can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {deps.isPending ? (
            <div aria-busy="true">
              <LoadingStatus>Checking what depends on “{name}”…</LoadingStatus>
              <SkeletonText width="70%" />
            </div>
          ) : deps.isError || !d ? (
            <Alert variant="destructive">
              <AlertTitle>What depends on it couldn’t be checked</AlertTitle>
              <AlertDescription>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void deps.refetch()}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              {blocked.length > 0 && (
                <Alert variant="warning">
                  <AlertTitle>It can’t be deleted yet</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-0.5 pl-4">
                      {blocked.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {entries > 0 && (
                <div className="space-y-1.5">
                  <Label className="gap-2 font-normal">
                    <Checkbox
                      aria-describedby="ct-delete-entries-hint"
                      checked={withEntries}
                      disabled={blocked.length > 0}
                      onCheckedChange={(c) => setWithEntries(c === true)}
                    />
                    Also delete its {plural(entries, 'entry', 'entries')}
                    {d.entries.trashed > 0 ? ` (${d.entries.trashed} in the trash)` : ''}
                  </Label>
                  <p id="ct-delete-entries-hint" className="text-muted-foreground text-ui">
                    A background job moves each to the trash, unpublishing the live ones, then
                    deletes it permanently. An entry other published entries link to is kept, and so
                    is the content type.
                  </p>
                </div>
              )}
              {blocked.length === 0 && (
                <div className="space-y-1.5">
                  <Label htmlFor="ct-delete-confirm">
                    Type <span className="font-mono">{apiId}</span> to confirm
                  </Label>
                  <Input
                    id="ct-delete-confirm"
                    value={typed}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="font-mono"
                    onChange={(e) => setTyped(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Keep it
            </Button>
            <Button type="submit" variant="destructive" disabled={!ready || busy}>
              {busy ? 'Deleting…' : entries > 0 ? 'Delete type and entries' : 'Delete content type'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
