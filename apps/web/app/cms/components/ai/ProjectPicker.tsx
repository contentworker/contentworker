import type { AiCapability } from '@contentworker/domain';
import { Label } from '@contentworker/ui/label';
import { cn } from '@contentworker/ui/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { useEffect, useId } from 'react';
import { type PickerValue, pickerOptions, usePickerShown } from '../../lib/ai-projects';

/**
 * Which AI project a call works in: "Default (Brand voice)" first, then the others, then None.
 * Hidden when the environment has no projects, when the person can't list them, and when every
 * capability it serves is off for the space (Settings → AI). Choosing is all it does: the API
 * resolves the project, checks it, and says what it used.
 */
export function ProjectPicker(props: {
  value: PickerValue;
  onChange: (value: PickerValue) => void;
  /** The capabilities the call it picks for runs under; shown while any of them is on. */
  capabilities: readonly AiCapability[];
  disabled?: boolean;
  /** A choice kept on an AI action or a schedule: no None, the default at each run first. */
  stored?: boolean;
  /** `compact` sits in a row of controls (the AI assist panel, Coworker's header). */
  variant?: 'field' | 'compact';
  className?: string;
}) {
  const { shown, projects } = usePickerShown(...props.capabilities);
  const id = useId();
  const options = pickerOptions(projects, { stored: props.stored });
  const listed = options.some((o) => o.value === props.value);
  // A project picked before it was deleted goes back to the default, in the caller's state too:
  // what the select shows is what the call sends.
  const { onChange } = props;
  useEffect(() => {
    if (shown && !listed) onChange('default');
  }, [shown, listed, onChange]);
  if (!shown) return null;
  const value = listed ? props.value : 'default';
  const chosen = options.find((o) => o.value === value) ?? options[0];
  const compact = props.variant === 'compact';
  return (
    <div
      className={cn(compact ? 'flex min-w-0 items-center gap-1.5' : 'space-y-1.5', props.className)}
    >
      <Label
        htmlFor={id}
        className={compact ? 'shrink-0 text-muted-foreground text-xs' : undefined}
      >
        Project
      </Label>
      <Select
        value={value}
        disabled={props.disabled}
        onValueChange={(v) => props.onChange(v as PickerValue)}
      >
        <SelectTrigger id={id} className={compact ? 'h-8 min-w-0 flex-1' : 'w-full sm:w-72'}>
          <SelectValue>{chosen?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} textValue={o.label}>
              <span className="truncate">{o.label}</span>
              {o.description ? (
                <>
                  <span className="sr-only">: </span>
                  <span className="ml-1.5 truncate text-muted-foreground text-xs">
                    {o.description}
                  </span>
                </>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
