import { Button } from '@contentworker/ui/button';
import { ComposeLoader, composeSequences } from '@contentworker/ui/compose-loader';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentworker/ui/dialog';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { Textarea } from '@contentworker/ui/textarea';
import { PenLine } from 'lucide-react';
import { useState } from 'react';
import type { ModelTier } from '../lib/management';

const TIERS: { value: ModelTier; label: string }[] = [
  { value: 'fast', label: 'Fast' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'flagship', label: 'Most capable' },
];

/**
 * Canvas authoring: write or paste free-form prose and let the model map it into
 * this content type's structured fields. The mapped values fill the editor form
 * and still pass the same validators a human write does.
 */
export function CanvasDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentTypeName: string;
  onMap: (prose: string, tier: ModelTier) => Promise<void>;
}) {
  const [prose, setProse] = useState('');
  const [tier, setTier] = useState<ModelTier>('balanced');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prose.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await props.onMap(prose.trim(), tier);
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Dismissal is blocked while a mapping is in flight: a late result landing
    // after the dialog closed would silently mutate the form.
    <Dialog open={props.open} onOpenChange={(o) => !busy && props.onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine className="size-4 text-primary" />
            Draft {props.contentTypeName} from prose
          </DialogTitle>
          <DialogDescription>
            Write freely. The model maps your prose into the structured fields, and you can edit
            anything before saving.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="canvas-prose">Prose</Label>
            <Textarea
              id="canvas-prose"
              rows={12}
              placeholder="Paste a draft, notes, or a free-form write-up. Everything that maps to a field will be extracted into it."
              value={prose}
              onChange={(e) => setProse(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="canvas-tier">Model</Label>
            <Select value={tier} onValueChange={(v) => setTier(v as ModelTier)}>
              <SelectTrigger id="canvas-tier" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIERS.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <p className="sr-only" aria-live="polite">
            {busy ? 'Mapping the text to fields.' : ''}
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !prose.trim()}>
              {busy ? (
                <>
                  <ComposeLoader icon={composeSequences.drafting} />
                  Mapping…
                </>
              ) : (
                'Map to fields'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
