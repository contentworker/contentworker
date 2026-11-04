import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@contentworker/ui/alert-dialog';
import { type ReactNode, useState } from 'react';

export interface ConfirmDialogProps {
  /** The question, naming the thing acted on: `Delete “Spring campaign”?` */
  readonly message: ReactNode;
  /** What goes with it, and that it can't be brought back. */
  readonly note: ReactNode;
  /** Label of the safe choice, which has focus. Defaults to "Cancel". */
  readonly cancelLabel?: string;
  /** Names the act: "Delete role", not "OK". */
  readonly confirmLabel: string;
  /** Disables the confirming button (e.g. while another request is in flight). */
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  /** Renders the trigger; call `ask` from its onClick to open the dialog. */
  readonly children: (ask: () => void) => ReactNode;
}

/**
 * A trigger that asks in a modal before removing something for good: how anything irreversible
 * that touches content, files or access confirms (`ConfirmButton` is its in-place counterpart, for
 * what can be undone). The safe choice has focus, and closing goes back to the trigger.
 *
 * ```tsx
 * <ConfirmDialog
 *   message={`Delete the role “${role.name}”?`}
 *   note="This can’t be undone."
 *   confirmLabel="Delete role"
 *   onConfirm={() => remove(role.id)}
 * >
 *   {(ask) => <Button variant="ghost" size="sm" onClick={ask}>Delete</Button>}
 * </ConfirmDialog>
 * ```
 */
export function ConfirmDialog({
  message,
  note,
  cancelLabel = 'Cancel',
  confirmLabel,
  busy,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      {children(() => setAsking(true))}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{message}</AlertDialogTitle>
            <AlertDialogDescription>{note}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={onConfirm}>
              {confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
