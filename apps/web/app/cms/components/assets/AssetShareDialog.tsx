import {
  type AssetShareLink,
  type AssetShareTargetType,
  MAX_SHARE_LINK_SECONDS,
  MAX_SHARE_PASSWORD,
  MIN_SHARE_LINK_SECONDS,
  MIN_SHARE_PASSWORD,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@contentworker/ui/dialog';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { SkeletonText } from '@contentworker/ui/skeleton';
import { Switch } from '@contentworker/ui/switch';
import { Copy, Link2 } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { ToneBadge } from '~/cms/components/status';
import {
  isoToLocalInput,
  SHARE_EXPIRY_CHOICES,
  type ShareExpiryChoice,
  shareExpiresAt,
  timeUntil,
} from '~/cms/lib/assets';
import { useClient } from '~/cms/lib/client-context';
import { dateTime } from '~/cms/lib/format';
import { apiErrorMessage, apiFieldIssues, isForbidden } from '~/cms/lib/management';
import { useInvalidate, useScopedQuery } from '~/cms/lib/queries';
import { useToast } from '~/cms/lib/toast';
import { useNow } from '~/cms/lib/use-now';

/** What is being shared: one asset or a collection, by the name an editor knows it by. */
export interface ShareTarget {
  readonly type: AssetShareTargetType;
  readonly id: string;
  readonly name: string;
}

const FORBIDDEN =
  'A share link opens files to anyone who holds it, so making, listing and revoking links take ' +
  'the content:publish permission, as publishing does. Ask a space administrator to share it, ' +
  'or for a role that has it.';

/**
 * Share links to an asset or a collection, in a dialog: make one (an expiry from presets or a
 * date of your own, whether files download, an optional password), then copy or revoke the links
 * that still open. A link only ever serves published files: an unpublished asset can't be shared
 * until it is published, and a collection's page leaves its drafts off. A role without
 * content:publish sees why it can't share, never a form that would be refused.
 */
export function AssetShareDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ShareTarget;
  /** For an asset: whether it is published (only a published asset can be shared). */
  published?: boolean;
}) {
  const { target } = props;
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const now = useNow(60_000);
  const id = useId();
  const key = ['share-links', target.type, target.id];
  const links = useScopedQuery(
    key,
    () => client.listShareLinks({ targetType: target.type, targetId: target.id }),
    { enabled: props.open, silent: true },
  );
  const [choice, setChoice] = useState<ShareExpiryChoice>('7d');
  const [custom, setCustom] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  // The link just made: it takes focus (its Copy button), so it can be copied at once.
  const [made, setMade] = useState<string | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  // What opened the dialog: opened by state, not a DialogTrigger, so Radix can't hand focus back
  // to it on close (inside the sheet, the sheet's focus trap would take it instead).
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (props.open && !wasOpen.current && typeof document !== 'undefined') {
    opener.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = props.open;
  const list = useRef<HTMLUListElement>(null);

  // A fresh form each time the dialog opens on a target.
  useEffect(() => {
    if (!props.open) return;
    setChoice('7d');
    setCustom('');
    setAllowDownload(true);
    setPassword('');
    setIssues({});
    setRefusal(null);
    setMade(null);
  }, [props.open, target.type, target.id]);

  useEffect(() => {
    if (!made) return;
    const copy = list.current?.querySelector<HTMLElement>(
      `[data-link-id="${CSS.escape(made)}"] [data-copy-link]`,
    );
    if (!copy) return;
    copy.focus();
    setMade(null);
  }, [made, links.data]);

  const forbidden = isForbidden(links.error);
  const unpublished = target.type === 'asset' && props.published === false;
  const active = links.data ?? [];

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setIssues({});
    setRefusal(null);
    const expiresAt = shareExpiresAt(choice, custom, Date.now());
    if (!expiresAt) {
      setIssues({ expiresAt: 'Choose the date and time the link stops opening.' });
      return;
    }
    setBusy(true);
    try {
      const link = await client.createShareLink({
        targetType: target.type,
        targetId: target.id,
        expiresAt,
        allowDownload,
        ...(password ? { password } : {}),
      });
      setPassword('');
      toast.success('Share link created');
      await invalidate(key);
      setMade(link.id);
    } catch (err) {
      const fields = apiFieldIssues(err);
      setIssues(fields);
      if (isForbidden(err)) setRefusal(FORBIDDEN);
      else if (!fields.expiresAt && !fields.password) setRefusal(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: AssetShareLink) => {
    try {
      await client.revokeShareLink(link.id);
      toast.success('Link revoked; it stops opening within a minute');
      await invalidate(key);
      listHeading.current?.focus();
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error('The link couldn’t be copied: select it and copy it yourself');
    }
  };

  // A field's error is an alert: heard when it appears, wherever focus is (the submit button).
  const issue = (field: 'expiresAt' | 'password') =>
    issues[field] ? (
      <p id={`${id}-${field}-error`} role="alert" className="text-destructive text-xs">
        {issues[field]}
      </p>
    ) : null;

  const what = target.type === 'asset' ? 'this file' : 'the collection’s files';
  const form = (
    <form className="space-y-4" onSubmit={create} noValidate aria-label="New share link">
      {refusal && (
        <Alert variant="destructive">
          <AlertTitle>The link wasn’t created</AlertTitle>
          <AlertDescription>{refusal}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-1.5">
        <Label id={`${id}-expiry`}>Expires after</Label>
        <Segmented
          aria-labelledby={`${id}-expiry`}
          aria-describedby={issues.expiresAt ? `${id}-expiresAt-error` : undefined}
          aria-invalid={issues.expiresAt && choice !== 'custom' ? true : undefined}
          value={choice}
          onValueChange={(v) => setChoice(v as ShareExpiryChoice)}
          className="w-full"
        >
          {SHARE_EXPIRY_CHOICES.map((c) => (
            <SegmentedItem key={c.value} value={c.value}>
              {c.label}
            </SegmentedItem>
          ))}
        </Segmented>
        {choice === 'custom' && (
          <div className="space-y-1 pt-1">
            <Label htmlFor={`${id}-custom`} className="text-xs">
              Expires at
            </Label>
            <Input
              id={`${id}-custom`}
              type="datetime-local"
              value={custom}
              min={isoToLocalInput(new Date(now + MIN_SHARE_LINK_SECONDS * 1000).toISOString())}
              max={isoToLocalInput(new Date(now + MAX_SHARE_LINK_SECONDS * 1000).toISOString())}
              onChange={(e) => setCustom(e.target.value)}
              aria-invalid={issues.expiresAt ? true : undefined}
              aria-describedby={`${id}-custom-hint${issues.expiresAt ? ` ${id}-expiresAt-error` : ''}`}
            />
            <p id={`${id}-custom-hint`} className="text-muted-foreground text-xs">
              On your clock. From 5 minutes to 90 days from now.
            </p>
          </div>
        )}
        {issue('expiresAt')}
      </div>
      <div className="flex items-start gap-3">
        <Switch
          id={`${id}-download`}
          checked={allowDownload}
          onCheckedChange={setAllowDownload}
          aria-describedby={`${id}-download-hint`}
        />
        <div className="space-y-0.5">
          <Label htmlFor={`${id}-download`}>Allow downloads</Label>
          <p id={`${id}-download-hint`} className="text-muted-foreground text-xs">
            Otherwise the files open in the browser only.
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-password`}>
          Password <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          minLength={MIN_SHARE_PASSWORD}
          maxLength={MAX_SHARE_PASSWORD}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={issues.password ? true : undefined}
          aria-describedby={`${id}-password-hint${issues.password ? ` ${id}-password-error` : ''}`}
        />
        <p id={`${id}-password-hint`} className="text-muted-foreground text-xs">
          At least {MIN_SHARE_PASSWORD} characters. Asked for before the page opens; send it
          separately from the link.
        </p>
        {issue('password')}
      </div>
      <Button type="submit" disabled={busy}>
        <Link2 aria-hidden="true" />
        {busy ? 'Creating…' : 'Create link'}
      </Button>
    </form>
  );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        onCloseAutoFocus={(e) => {
          if (!opener.current?.isConnected) return;
          e.preventDefault();
          opener.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="truncate">Share “{target.name}”</DialogTitle>
          <DialogDescription>
            Anyone with the link can view {what} until it expires or you revoke it. Only published
            files are shared
            {target.type === 'collection'
              ? ': drafts in the collection stay off the page until they are published.'
              : '.'}
          </DialogDescription>
        </DialogHeader>

        {links.isPending && props.open ? (
          <div className="space-y-1 text-xs">
            <LoadingStatus>Loading share links…</LoadingStatus>
            <SkeletonText width="80%" />
            <SkeletonText width="60%" />
          </div>
        ) : forbidden ? (
          <Alert variant="warning">
            <AlertTitle>Your role can’t share</AlertTitle>
            <AlertDescription>{FORBIDDEN}</AlertDescription>
          </Alert>
        ) : links.error ? (
          <Alert variant="destructive">
            <AlertTitle>The share links didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(links.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void links.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {unpublished ? (
              <Alert variant="warning">
                <AlertTitle>Publish it to share it</AlertTitle>
                <AlertDescription>
                  A share link only serves published files, and this asset isn’t published.
                </AlertDescription>
              </Alert>
            ) : (
              form
            )}
            <div className="space-y-2">
              <h3
                ref={listHeading}
                tabIndex={-1}
                className="section-title outline-none"
                id={`${id}-active`}
              >
                Active links
              </h3>
              {active.length === 0 ? (
                <p className="text-muted-foreground text-sm">No link opens it now.</p>
              ) : (
                <ul ref={list} aria-labelledby={`${id}-active`} className="divide-y text-sm">
                  {active.map((link) => {
                    const at = Date.parse(link.expiresAt);
                    const when = `${timeUntil(at, now)} (${dateTime(at)})`;
                    return (
                      <li key={link.id} data-link-id={link.id} className="space-y-1.5 py-2">
                        {link.url ? (
                          <code className="block truncate font-mono text-xs" title={link.url}>
                            {link.url}
                          </code>
                        ) : (
                          <p className="text-muted-foreground text-xs">
                            No address: this deployment has no media origin configured.
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-muted-foreground text-xs">Expires {when}</span>
                          {link.hasPassword && <ToneBadge tone="idle" label="Password" />}
                          <ToneBadge
                            tone="idle"
                            label={link.allowDownload ? 'Downloads allowed' : 'View only'}
                          />
                          <div className="ml-auto flex items-center gap-1">
                            {link.url && (
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                data-copy-link=""
                                aria-label={`Copy the link that expires ${dateTime(at)}`}
                                onClick={() => void copy(link.url as string)}
                              >
                                <Copy aria-hidden="true" />
                                Copy
                              </Button>
                            )}
                            <ConfirmButton
                              message="Revoke this link?"
                              note="It stops opening within a minute. This can’t be undone."
                              confirmLabel="Revoke link"
                              onConfirm={() => void revoke(link)}
                            >
                              {(ask) => (
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="ghost"
                                  aria-label={`Revoke the link that expires ${dateTime(at)}`}
                                  onClick={ask}
                                >
                                  Revoke
                                </Button>
                              )}
                            </ConfirmButton>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
