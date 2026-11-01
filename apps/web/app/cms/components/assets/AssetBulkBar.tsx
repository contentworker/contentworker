import type { AssetFolder } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { NativeSelect, NativeSelectOption } from '@contentworker/ui/native-select';
import { Archive, FolderInput, Send, X } from 'lucide-react';
import { useState } from 'react';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { folderLabel, folderRows } from '~/cms/lib/assets';
import { plural } from '~/cms/lib/format';

const ROOT = '__root__';

/**
 * What can be done to the selected assets at once: file them, publish them, archive them. Labelled
 * as the entries list labels its selection ("2 selected", "Publish selected"). Archiving several
 * asks first, in place: undoing it would mean restoring each one, and they come back as drafts.
 */
export function AssetBulkBar(props: {
  count: number;
  folders: readonly AssetFolder[];
  busy: boolean;
  onMove: (folderId: string | null) => void;
  onPublish: () => void;
  onArchive: () => void;
  onClear: () => void;
}) {
  const [target, setTarget] = useState(ROOT);
  if (props.count === 0) return null;
  const noun = plural(props.count, 'asset');
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a form fieldset
    <div
      role="group"
      aria-label="Selected assets"
      className="flex flex-wrap items-center gap-2 rounded-2xl bg-muted px-3 py-2 animate-arrive"
    >
      <span className="text-muted-foreground text-sm">{props.count} selected</span>
      <Button type="button" size="sm" disabled={props.busy} onClick={props.onPublish}>
        <Send aria-hidden="true" />
        Publish selected
      </Button>
      <ConfirmButton
        message={`Archive ${noun}?`}
        note="They stop being delivered at once. Restore brings each one back as a draft."
        confirmLabel={`Archive ${noun}`}
        busy={props.busy}
        onConfirm={props.onArchive}
      >
        {(ask) => (
          <Button type="button" size="sm" variant="outline" disabled={props.busy} onClick={ask}>
            <Archive aria-hidden="true" />
            Archive selected
          </Button>
        )}
      </ConfirmButton>
      <div className="flex flex-wrap items-center gap-1">
        <NativeSelect
          size="sm"
          aria-label="Move to folder"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <NativeSelectOption value={ROOT}>Not in a folder</NativeSelectOption>
          {folderRows(props.folders).map(({ folder }) => (
            <NativeSelectOption key={folder.id} value={folder.id}>
              {folderLabel(folder, props.folders)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onMove(target === ROOT ? null : target)}
        >
          <FolderInput aria-hidden="true" />
          Move selected
        </Button>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="ml-auto"
        aria-label="Clear selection"
        onClick={props.onClear}
      >
        <X aria-hidden="true" />
        Clear
      </Button>
    </div>
  );
}
