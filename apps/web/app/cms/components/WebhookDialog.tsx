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
import { useState } from 'react';
import { WEBHOOK_TOPICS, type WebhookSummary, type WebhookTopic } from '../lib/management';

/** Edit a webhook's endpoint, topics, secret, and active state. */
export function WebhookDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  webhook: WebhookSummary;
  onSave: (changes: {
    url: string;
    topics: WebhookTopic[];
    active: boolean;
    secret?: string;
  }) => Promise<void>;
}) {
  const [url, setUrl] = useState(props.webhook.url);
  const [topics, setTopics] = useState<WebhookTopic[]>([...props.webhook.topics]);
  const [active, setActive] = useState(props.webhook.active);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const toggleTopic = (t: WebhookTopic) =>
    setTopics((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || topics.length === 0) {
      setError('A URL and at least one topic are required.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      // secret is write-only and never returned — only send it when changed.
      await props.onSave({
        url: url.trim(),
        topics,
        active,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
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
          <DialogTitle>Edit webhook</DialogTitle>
          <DialogDescription>Change the endpoint, topics, or signing secret.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wh-url">Endpoint URL</Label>
            <Input id="wh-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wh-secret">Signing secret</Label>
            <Input
              id="wh-secret"
              type="password"
              placeholder="leave blank to keep the current secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Topics</span>
            <div className="flex flex-wrap gap-4">
              {WEBHOOK_TOPICS.map((t) => (
                <Label key={t} className="flex items-center gap-2 font-normal">
                  {/* A wrapping label does not name a <button role="checkbox">;
                      see the note in Settings.tsx. */}
                  <Checkbox
                    aria-label={t}
                    checked={topics.includes(t)}
                    onCheckedChange={() => toggleTopic(t)}
                  />
                  <span>{t}</span>
                </Label>
              ))}
            </div>
          </div>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              aria-label="Active (deliver events)"
              checked={active}
              onCheckedChange={(c) => setActive(c === true)}
            />
            <span>Active (deliver events)</span>
          </Label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
