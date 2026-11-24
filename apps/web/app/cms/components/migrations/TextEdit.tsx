import { Button } from '@contentworker/ui/button';
import { Label } from '@contentworker/ui/label';
import { Textarea } from '@contentworker/ui/textarea';
import { useEffect, useId, useRef, useState } from 'react';
import { UNCONFIRMED_NOTE } from '~/cms/components/discard-guard';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { apiIssues, refusedSave, saveFailureMessage } from '~/cms/lib/management';
import { HELD } from './step-parts';

/**
 * A template's model or script as text, edited in place of its read-only view. What stops a save
 * (this screen's check, or the API's refusal, as it names them) is listed under the text; Cancel
 * asks before it drops an edit, and a version saved by someone else meanwhile is said before it is
 * replaced.
 */
export function TextEdit({
  label,
  hint,
  initial,
  check,
  onSave,
  onClose,
  onDirty,
  onUnconfirmed,
  changedUnder,
  saveLabel,
}: {
  label: string;
  hint: string;
  initial: string;
  /** Why this text can't be sent, or undefined when it can. */
  check: (text: string) => string | undefined;
  /** Saves it, rejecting with what stopped it. */
  onSave: (text: string) => Promise<void>;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
  /** A save got no answer, so it may have landed. */
  onUnconfirmed: () => void;
  /** The stored version isn't the one this edit started from. */
  changedUnder: boolean;
  saveLabel: string;
}) {
  const id = useId();
  const [text, setText] = useState(initial);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  // A save with no answer may have landed, and discarding can't undo it.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [asking, setAsking] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== initial;
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;

  useEffect(() => area.current?.focus(), []);
  useEffect(() => onDirtyRef.current(dirty), [dirty]);
  useEffect(() => () => onDirtyRef.current(false), []);

  const save = async () => {
    if (saving) return;
    const stop = check(text);
    if (stop) {
      setIssues([stop]);
      area.current?.focus();
      return;
    }
    setSaving(true);
    setIssues([]);
    try {
      await onSave(text);
    } catch (err) {
      setSaving(false);
      if (!refusedSave(err)) {
        setUnconfirmed(true);
        onUnconfirmed();
      }
      const named = apiIssues(err).map((i) => `${i.field}: ${i.message}`);
      setIssues(named.length > 0 ? named : [saveFailureMessage(err)]);
      area.current?.focus();
      return;
    }
    onClose();
  };

  const shown = issues;
  return (
    <div className="space-y-2">
      <Label htmlFor={`${id}-text`}>{label}</Label>
      <p id={`${id}-hint`} className="max-w-measure text-muted-foreground text-xs">
        {hint}
      </p>
      <Textarea
        id={`${id}-text`}
        ref={area}
        rows={16}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        dir="ltr"
        className="font-mono text-xs"
        value={text}
        // Held, focus kept: what is typed while it saves wouldn't be in it.
        readOnly={saving}
        onChange={(e) => {
          setText(e.target.value);
          setIssues([]);
        }}
        aria-invalid={shown.length > 0 || undefined}
        aria-describedby={`${id}-hint${shown.length > 0 ? ` ${id}-issues` : ''}`}
      />
      {shown.length > 0 ? (
        <ul id={`${id}-issues`} role="alert" className="space-y-0.5 text-destructive text-ui">
          {shown.map((i) => (
            <li key={i} className="wrap-anywhere">
              {i}
            </li>
          ))}
        </ul>
      ) : null}
      {changedUnder ? (
        <p role="status" className="max-w-measure text-ui text-wait">
          Another version was saved since you started. Saving this replaces it.
        </p>
      ) : null}
      {asking ? (
        <InlineConfirm
          message="Discard this edit?"
          note={unconfirmed ? UNCONFIRMED_NOTE : 'Nothing has been saved.'}
          cancelLabel="Keep editing"
          onCancel={() => setAsking(false)}
          returnFocus={() => area.current}
        >
          <Button type="button" size="sm" variant="destructive" onClick={onClose}>
            Discard
          </Button>
        </InlineConfirm>
      ) : (
        <div className="flex flex-wrap justify-end gap-2 touch:gap-5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-disabled={saving || undefined}
            className={HELD}
            onClick={() => {
              if (saving) return;
              if (dirty) setAsking(true);
              else onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            aria-disabled={saving || undefined}
            className={HELD}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : saveLabel}
          </Button>
        </div>
      )}
    </div>
  );
}
