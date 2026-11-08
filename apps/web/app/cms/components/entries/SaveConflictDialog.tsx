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

/**
 * A draft save refused because someone saved the entry after it was opened (a 409 from
 * `expectedVersion`), and the honest way on: keep editing, load their version (what is typed
 * here is discarded), or save over theirs (it stays in the version history, to restore). The
 * entry form and the canvas editor both ask this; neither ever overwrites a save unseen.
 */
export function SaveConflictDialog(props: {
  readonly open: boolean;
  /** The version the entry is at now, when the refusal said. */
  readonly theirs: number | null;
  /** The version the edits were made from. */
  readonly mine: number;
  /** Where the edits are: "the form", "the canvas". */
  readonly where: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLoadTheirs: () => void;
  readonly onSaveOver: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Someone saved this entry while you worked</AlertDialogTitle>
          <AlertDialogDescription>
            It’s at {props.theirs ? `v${props.theirs}` : 'a newer version'} now, and {props.where}{' '}
            started from v{props.mine}. Load theirs to see what changed (your edits here are
            discarded), or save yours over it: theirs stays in the version history, and can be
            restored from there.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={props.onLoadTheirs}>
            Load theirs
          </AlertDialogAction>
          <AlertDialogAction variant="default" onClick={props.onSaveOver}>
            Save mine over it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
