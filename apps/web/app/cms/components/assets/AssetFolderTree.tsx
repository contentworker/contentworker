import type { AssetFolder } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { Input } from '@contentworker/ui/input';
import { cn } from '@contentworker/ui/lib/utils';
import { Folder, FolderOpen, FolderPlus, Inbox, Layers, Pencil } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { type FolderSelection, folderRows } from '~/cms/lib/assets';

const same = (a: FolderSelection, b: FolderSelection) =>
  a.kind === b.kind && (a.kind !== 'folder' || (b.kind === 'folder' && a.id === b.id));

function TreeButton(props: {
  current: boolean;
  depth?: number;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={props.current ? 'true' : undefined}
      onClick={props.onClick}
      style={props.depth ? { paddingLeft: `${0.75 + props.depth * 1}rem` } : undefined}
      className={cn(
        'hit-area flex w-full items-center gap-2 rounded-full px-3 py-1.5 text-left text-sm outline-none transition-[background-color] hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        props.current && 'bg-muted font-medium',
      )}
    >
      {props.icon}
      <span className="truncate">{props.children}</span>
    </button>
  );
}

/** A one-line form for a folder's name: creating one, or renaming it. */
function NameForm(props: {
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.initial ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await props.onSubmit(name.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 px-1 py-1">
      <Input
        aria-label={props.label}
        value={name}
        autoFocus
        maxLength={128}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}
        className="h-8"
      />
      <div className="flex gap-1">
        <Button type="submit" size="xs" disabled={busy || !name.trim()}>
          {props.submitLabel}
        </Button>
        <Button type="button" size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The library's folders as a tree: everything, the assets in no folder, then each folder nested
 * under its parent. A new folder goes inside the one that is open (at the root otherwise); the
 * open folder can be renamed, or deleted once it is empty.
 */
export function AssetFolderTree(props: {
  folders: readonly AssetFolder[];
  value: FolderSelection;
  onChange: (next: FolderSelection) => void;
  onCreate: (name: string, parentId?: string) => Promise<void>;
  onRename: (folder: AssetFolder, name: string) => Promise<void>;
  onDelete: (folder: AssetFolder) => Promise<void>;
}) {
  const { folders, value, onChange } = props;
  const [mode, setMode] = useState<'idle' | 'create' | 'rename'>('idle');
  const open = value.kind === 'folder' ? folders.find((f) => f.id === value.id) : undefined;
  const rows = folderRows(folders);
  return (
    <nav aria-label="Folders" className="flex flex-col gap-0.5">
      <TreeButton
        current={same(value, { kind: 'all' })}
        icon={<Layers />}
        onClick={() => onChange({ kind: 'all' })}
      >
        All assets
      </TreeButton>
      <TreeButton
        current={same(value, { kind: 'root' })}
        icon={<Inbox />}
        onClick={() => onChange({ kind: 'root' })}
      >
        Not in a folder
      </TreeButton>
      {rows.map(({ folder, depth }) => {
        const current = value.kind === 'folder' && value.id === folder.id;
        return (
          <TreeButton
            key={folder.id}
            current={current}
            depth={depth}
            icon={current ? <FolderOpen /> : <Folder />}
            onClick={() => onChange({ kind: 'folder', id: folder.id })}
          >
            {folder.name}
          </TreeButton>
        );
      })}
      <div className="mt-2 border-t pt-2">
        {mode === 'create' ? (
          <NameForm
            label={open ? `New folder in “${open.name}”` : 'New folder name'}
            submitLabel="Create folder"
            onCancel={() => setMode('idle')}
            onSubmit={async (name) => {
              await props.onCreate(name, open?.id);
              setMode('idle');
            }}
          />
        ) : mode === 'rename' && open ? (
          <NameForm
            label={`Rename “${open.name}”`}
            initial={open.name}
            submitLabel="Rename"
            onCancel={() => setMode('idle')}
            onSubmit={async (name) => {
              await props.onRename(open, name);
              setMode('idle');
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setMode('create')}>
              <FolderPlus aria-hidden="true" />
              {open ? 'New subfolder' : 'New folder'}
            </Button>
            {open && (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={`Rename “${open.name}”`}
                  onClick={() => setMode('rename')}
                >
                  <Pencil aria-hidden="true" />
                  Rename
                </Button>
                <ConfirmButton
                  message={`Delete “${open.name}”?`}
                  note="Only an empty folder can be deleted."
                  confirmLabel="Delete folder"
                  onConfirm={() => void props.onDelete(open)}
                >
                  {(ask) => (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      aria-label={`Delete “${open.name}”`}
                      onClick={ask}
                    >
                      Delete
                    </Button>
                  )}
                </ConfirmButton>
              </>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
