import { Button } from '@contentworker/ui/button';
import { Input } from '@contentworker/ui/input';
import { cn } from '@contentworker/ui/lib/utils';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
  AtSign,
  Bold,
  Code,
  FileImage,
  FileSymlink,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { useContext, useId, useState } from 'react';
import { EntityPicker } from '~/cms/components/EntityPicker';
import type { PickOption } from '../EntryForm';
import { RichTextPickersContext } from './EmbedNodeView';

/** Which secondary row is open under the toolbar. */
type PickerRow = 'link' | 'entryLink' | 'assetLink' | 'inlineEntry' | null;

function ToolbarButton(props: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('size-8', props.active && 'bg-muted text-foreground')}
      data-active={props.active || undefined}
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

function TargetPickerRow(props: {
  label: string;
  options: PickOption[];
  onApply: (id: string) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState('');
  const pickerId = useId();
  return (
    <div className="flex items-center gap-2 border-t p-2">
      <span className="text-muted-foreground text-xs">{props.label}</span>
      <div className="min-w-0 flex-1">
        <EntityPicker
          id={pickerId}
          ariaLabel="Pick a target"
          options={props.options}
          value={id}
          placeholder="Search for a target…"
          onChange={(v) => setId(v ?? '')}
        />
      </div>
      <Button type="button" size="sm" disabled={!id} onClick={() => props.onApply(id)}>
        Apply
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Formatting toolbar for the rich-text editor. */
/**
 * Every flag off — what the toolbar reports while the editor has no view to
 * ask. Rendering a briefly-inert toolbar is the correct degradation; throwing
 * takes the whole editor route down with it.
 */
const IDLE_STATE = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: false,
  entryLink: false,
  assetLink: false,
  h1: false,
  h2: false,
  h3: false,
  bulletList: false,
  orderedList: false,
  blockquote: false,
  codeBlock: false,
  canUndo: false,
  canRedo: false,
};

export function Toolbar(props: { editor: Editor }) {
  const { editor } = props;
  const pickers = useContext(RichTextPickersContext);
  const [row, setRow] = useState<PickerRow>(null);
  const [href, setHref] = useState('');

  // Re-render on selection/content changes so active states stay fresh.
  //
  // The selector can run in the window between the Editor instance existing and
  // its EditorView being attached — and again after destroy. `isActive` tolerates
  // that, but `can()` reaches into the view and throws
  // ("Cannot read properties of null"), which escapes to the router and replaces
  // the whole entry editor with an error page. It is intermittent, so it
  // surfaced as a flaky e2e rather than an obvious break.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e?.view || e.isDestroyed) return IDLE_STATE;
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        code: e.isActive('code'),
        link: e.isActive('link'),
        entryLink: e.isActive('entryLink'),
        assetLink: e.isActive('assetLink'),
        h1: e.isActive('heading', { level: 1 }),
        h2: e.isActive('heading', { level: 2 }),
        h3: e.isActive('heading', { level: 3 }),
        bulletList: e.isActive('bulletList'),
        orderedList: e.isActive('orderedList'),
        blockquote: e.isActive('blockquote'),
        codeBlock: e.isActive('codeBlock'),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });

  const chain = () => editor.chain().focus();
  const toggleRow = (next: Exclude<PickerRow, null>) => setRow(row === next ? null : next);

  const toggleLink = () => {
    if (state.link) {
      chain().unsetLink().run();
      return;
    }
    setHref(editor.getAttributes('link').href ?? '');
    toggleRow('link');
  };
  const applyLink = () => {
    // Exclusion is one-way (our ref marks exclude link, not vice versa), so
    // clear them explicitly or setLink would silently no-op on ref-linked text.
    if (href.trim()) {
      chain()
        .extendMarkRange('link')
        .unsetMark('entryLink')
        .unsetMark('assetLink')
        .setLink({ href: href.trim() })
        .run();
    }
    setRow(null);
    setHref('');
  };
  // Mark exclusivity (excludes in extensions.ts) clears any other link kind.
  const toggleRefLink = (mark: 'entryLink' | 'assetLink') => {
    if (state[mark]) {
      chain().extendMarkRange(mark).unsetMark(mark).run();
      return;
    }
    toggleRow(mark);
  };
  const applyRefLink = (mark: 'entryLink' | 'assetLink', targetId: string) => {
    // extendMarkRange lets a collapsed cursor inside an existing link retarget it.
    chain().extendMarkRange(mark).setMark(mark, { targetId }).run();
    setRow(null);
  };
  const insertInlineEntry = (targetId: string) => {
    chain().insertContent({ type: 'embeddedEntryInline', attrs: { targetId } }).run();
    setRow(null);
  };

  return (
    <div className="border-b">
      <div
        role="toolbar"
        aria-label="Text formatting"
        className="flex flex-wrap items-center gap-0.5 p-1"
      >
        <ToolbarButton label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}>
          <Bold className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          active={state.italic}
          onClick={() => chain().toggleItalic().run()}
        >
          <Italic className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Underline"
          active={state.underline}
          onClick={() => chain().toggleUnderline().run()}
        >
          <Underline className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Strikethrough"
          active={state.strike}
          onClick={() => chain().toggleStrike().run()}
        >
          <Strikethrough className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Code" active={state.code} onClick={() => chain().toggleCode().run()}>
          <Code className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Link" active={state.link} onClick={toggleLink}>
          <Link2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Link to entry"
          active={state.entryLink}
          onClick={() => toggleRefLink('entryLink')}
        >
          <FileSymlink className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Link to asset"
          active={state.assetLink}
          onClick={() => toggleRefLink('assetLink')}
        >
          <FileImage className="size-4" />
        </ToolbarButton>

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolbarButton
          label="Heading 1"
          active={state.h1}
          onClick={() => chain().toggleHeading({ level: 1 }).run()}
        >
          <Heading1 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Heading 2"
          active={state.h2}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Heading 3"
          active={state.h3}
          onClick={() => chain().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 className="size-4" />
        </ToolbarButton>

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolbarButton
          label="Bullet list"
          active={state.bulletList}
          onClick={() => chain().toggleBulletList().run()}
        >
          <List className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Ordered list"
          active={state.orderedList}
          onClick={() => chain().toggleOrderedList().run()}
        >
          <ListOrdered className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Quote"
          active={state.blockquote}
          onClick={() => chain().toggleBlockquote().run()}
        >
          <Quote className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Code block"
          active={state.codeBlock}
          onClick={() => chain().toggleCodeBlock().run()}
        >
          <SquareCode className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Horizontal rule" onClick={() => chain().setHorizontalRule().run()}>
          <Minus className="size-4" />
        </ToolbarButton>

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolbarButton
          label="Embed entry"
          onClick={() => chain().insertContent({ type: 'embeddedEntryBlock' }).run()}
        >
          <FileText className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          label="Embed asset"
          onClick={() => chain().insertContent({ type: 'embeddedAssetBlock' }).run()}
        >
          <Image className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Inline entry" onClick={() => toggleRow('inlineEntry')}>
          <AtSign className="size-4" />
        </ToolbarButton>

        <span className="mx-1 h-5 w-px bg-border" />

        <ToolbarButton label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}>
          <Undo2 className="size-4" />
        </ToolbarButton>
        <ToolbarButton label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}>
          <Redo2 className="size-4" />
        </ToolbarButton>
      </div>

      {row === 'link' && (
        <div className="flex items-center gap-2 border-t p-2">
          <Input
            className="h-8"
            placeholder="https://…"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
            }}
          />
          <Button type="button" size="sm" onClick={applyLink}>
            Set link
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRow(null)}>
            Cancel
          </Button>
        </div>
      )}
      {row === 'entryLink' && (
        <TargetPickerRow
          label="Link selection to entry"
          options={pickers.entries}
          onApply={(id) => applyRefLink('entryLink', id)}
          onCancel={() => setRow(null)}
        />
      )}
      {row === 'assetLink' && (
        <TargetPickerRow
          label="Link selection to asset"
          options={pickers.assets}
          onApply={(id) => applyRefLink('assetLink', id)}
          onCancel={() => setRow(null)}
        />
      )}
      {row === 'inlineEntry' && (
        <TargetPickerRow
          label="Insert inline entry"
          options={pickers.entries}
          onApply={insertInlineEntry}
          onCancel={() => setRow(null)}
        />
      )}
    </div>
  );
}
