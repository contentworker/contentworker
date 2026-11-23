import { SCOPES } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Checkbox } from '@contentworker/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentworker/ui/dialog';
import { Label } from '@contentworker/ui/label';
import { useEffect, useRef, useState } from 'react';
import { DiscardAsk, GuardCancel, useDiscardGuard } from '~/cms/components/discard-guard';
import { useClient } from '~/cms/lib/client-context';
import { ApiError, apiErrorMessage, type DocumentTemplate } from '~/cms/lib/management';
import { useScopedQuery } from '~/cms/lib/queries';
import { useToast } from '~/cms/lib/toast';

const options = [
  { key: 'createMediaDrafts', label: 'Create DAM drafts for embedded files' },
  { key: 'suggestTags', label: 'Apply AI tags when tags are empty' },
  { key: 'describeDocument', label: 'Write an AI description when the default locale has none' },
] as const;

export function DocumentTemplateSettings() {
  const [open, setOpen] = useState(false);
  const { conn } = useClient();
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Ingestion settings
      </Button>
      {open && (
        <TemplateDialog
          key={JSON.stringify([conn.space, conn.environment])}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}

function TemplateDialog({ close }: { close: () => void }) {
  const { client, conn } = useClient();
  const toast = useToast();
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), { silent: true });
  const writable = access.data?.scopes.includes(SCOPES.assetsWrite) === true;
  const [saved, setSaved] = useState<DocumentTemplate>();
  const [draft, setDraft] = useState<DocumentTemplate>();
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const reviewButton = useRef<HTMLButtonElement>(null);
  const optionsField = useRef<HTMLFieldSetElement>(null);
  const focusAfterReview = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (conflict) reviewButton.current?.focus();
    else if (focusAfterReview.current) {
      focusAfterReview.current = false;
      optionsField.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }, [conflict, loading]);
  const dirty = options.some(({ key }) => saved?.[key] !== draft?.[key]);
  const guard = useDiscardGuard({
    dirty,
    saving,
    onOpenChange: (open) => {
      if (!open) close();
    },
  });
  useEffect(() => {
    const request = new AbortController();
    setLoading(true);
    setError('');
    client
      .getDocumentTemplate(request.signal)
      .then((template) => {
        if (request.signal.aborted) return;
        setSaved(template);
        setDraft(template);
      })
      .catch((err) => {
        if (!request.signal.aborted) setError(apiErrorMessage(err));
      })
      .finally(() => {
        if (!request.signal.aborted) setLoading(false);
      });
    return () => request.abort();
  }, [client, attempt]);

  async function reviewLatest() {
    if (!saved || !draft) return;
    setLoading(true);
    try {
      const latest = await client.getDocumentTemplate();
      const edits = Object.fromEntries(
        options.filter(({ key }) => draft[key] !== saved[key]).map(({ key }) => [key, draft[key]]),
      );
      setSaved(latest);
      setDraft({ ...latest, ...edits });
      focusAfterReview.current = true;
      setConflict(false);
      setError('');
      setNotice('Latest settings loaded. Review your selections before saving.');
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!draft || !dirty || !writable || saving || loading || conflict) return;
    setSaving(true);
    try {
      await client.setDocumentTemplate(draft);
      toast.success('Document ingestion settings saved');
      close();
    } catch (err) {
      setError(guard.saveFailed(err));
      setConflict(err instanceof ApiError && err.status === 409);
      setNotice('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={guard.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Document ingestion settings</DialogTitle>
          <DialogDescription>
            For new PDF, PowerPoint and Keynote runs using the document parser in {conn.space} /{' '}
            {conn.environment}.
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading settings…
          </p>
        )}
        {draft && (
          <fieldset
            ref={optionsField}
            className="space-y-3"
            disabled={!writable || loading || saving || conflict}
          >
            <legend className="sr-only">Document ingestion options</legend>
            {options.map(({ key, label }) => (
              <Label key={key} className="flex items-center gap-2 font-normal">
                <Checkbox
                  aria-label={label}
                  checked={draft[key]}
                  disabled={!writable || loading || saving || conflict}
                  onCheckedChange={(v) => setDraft({ ...draft, [key]: v === true })}
                />
                <span>{label}</span>
              </Label>
            ))}
          </fieldset>
        )}
        {draft && access.data && !writable && (
          <p className="text-sm text-muted-foreground">Your role can view these settings.</p>
        )}
        {access.isError && (
          <div>
            <DialogError>{apiErrorMessage(access.error)}</DialogError>
            <Button variant="outline" size="sm" onClick={() => void access.refetch()}>
              Retry permissions
            </Button>
          </div>
        )}
        {notice && (
          <p role="status" className="text-sm">
            {notice}
          </p>
        )}
        {error && <DialogError>{error}</DialogError>}
        {conflict && (
          <Button
            ref={reviewButton}
            variant="outline"
            disabled={loading}
            onClick={() => void reviewLatest()}
          >
            Review latest settings
          </Button>
        )}
        {!draft && error && (
          <Button variant="outline" disabled={loading} onClick={() => setAttempt((a) => a + 1)}>
            Retry loading settings
          </Button>
        )}
        <DialogFooter>
          <DiscardAsk guard={guard} message="Discard your changes to document ingestion?">
            {writable ? (
              <>
                <GuardCancel guard={guard} />
                <Button
                  disabled={!dirty || loading || saving || conflict}
                  onClick={() => void save()}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => guard.onOpenChange(false)}>
                Close
              </Button>
            )}
          </DiscardAsk>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
