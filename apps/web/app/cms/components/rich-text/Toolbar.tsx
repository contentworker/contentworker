import { EMBED_PROVIDERS } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentworker/ui/dropdown-menu';
import { Input } from '@contentworker/ui/input';
import { Kbd } from '@contentworker/ui/kbd';
import { cn } from '@contentworker/ui/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@contentworker/ui/tooltip';
import { isInTable, selectedRect } from '@tiptap/pm/tables';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
  AtSign,
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Bold,
  ChevronDown,
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
  PanelTop,
  PlaySquare,
  Plus,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table,
  Trash2,
  Underline,
  Undo2,
} from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { EntityPicker } from '~/cms/components/EntityPicker';
import { useFinePointer, useModKeyLabel } from '~/cms/lib/shortcuts';
import type { PickOption } from '../EntryForm';
import { RichTextPickersContext } from './EmbedNodeView';
import { type EmbedResolver, embedFromUrl, insertExternalEmbed } from './external-embed';
import { ariaKeyShortcuts, type Chord, chordLabel, EDITOR_KEYS } from './keys';

/** What the embed row accepts, read to screen readers with its field. */
const EMBED_PROVIDER_LIST = `A link from ${EMBED_PROVIDERS.map((p) => p.name).join(', ')}.`;

/** Which secondary row is open under the toolbar. */
type PickerRow = 'link' | 'entryLink' | 'assetLink' | 'inlineEntry' | 'embed' | null;

/**
 * The WAI-ARIA toolbar pattern: the toolbar is one Tab stop, and ←/→ (Home/End) move between its
 * controls. The stop is the control last focused in it, so Tab comes back to where one left off;
 * a control that has gone or been disabled hands the stop back to the first.
 */
const RovingContext = createContext<{ stop: string; focused: (key: string) => void }>({
  stop: '',
  focused: () => {},
});

function useRovingItem(key: string) {
  const { stop, focused } = useContext(RovingContext);
  return {
    tabIndex: stop === key ? 0 : -1,
    'data-roving-item': key,
    onFocus: () => focused(key),
  };
}

const ROVING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

function RovingToolbar(props: {
  label: string;
  /** The control that holds the Tab stop first: one that is never disabled. */
  first: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(props.first);
  const items = () =>
    [...(ref.current?.querySelectorAll<HTMLButtonElement>('[data-roving-item]') ?? [])].filter(
      (el) => !el.disabled,
    );

  useLayoutEffect(() => {
    if (current === props.first) return;
    if (!items().some((el) => el.dataset.rovingItem === current)) setCurrent(props.first);
  });

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!ROVING_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = items();
    const at = list.indexOf(e.target as HTMLButtonElement);
    // Keys typed in a row under the toolbar, or in an open menu, are theirs.
    if (at < 0) return;
    const next =
      e.key === 'Home'
        ? list[0]
        : e.key === 'End'
          ? list[list.length - 1]
          : list[(at + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    e.preventDefault();
    next?.focus();
  };

  return (
    <RovingContext.Provider value={{ stop: current, focused: setCurrent }}>
      <div
        ref={ref}
        role="toolbar"
        aria-label={props.label}
        aria-orientation="horizontal"
        className={props.className}
        onKeyDown={onKeyDown}
      >
        {props.children}
      </div>
    </RovingContext.Provider>
  );
}

/**
 * An icon control, named by a tooltip (with its key where the editor binds one) as well as its
 * aria-label. The key is shown to a mouse only (DESIGN.md: no keyboard hints to a finger), and
 * given to assistive technology as `aria-keyshortcuts`.
 */
function ToolbarButton(props: {
  id: string;
  label: string;
  keys?: Chord;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const roving = useRovingItem(props.id);
  const fine = useFinePointer();
  const apple = useModKeyLabel() === '⌘';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('size-8', props.active && 'bg-muted text-foreground')}
          data-active={props.active || undefined}
          aria-label={props.label}
          aria-pressed={props.active}
          aria-keyshortcuts={props.keys ? ariaKeyShortcuts(props.keys) : undefined}
          disabled={props.disabled}
          {...roving}
          onMouseDown={(e) => e.preventDefault()}
          onClick={props.onClick}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {props.label}
        {props.keys && fine ? <Kbd>{chordLabel(props.keys, apple)}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A table control: icon and words, because "delete column" and "delete row"
 * are not things an icon alone says. Like ToolbarButton it keeps the editor's
 * selection on press, so the command acts on the cell the cursor is in.
 */
function TableButton(props: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  const roving = useRovingItem(props.label);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(props.pressed && 'bg-muted text-foreground')}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      {...roving}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      <Icon className="size-4" />
      {props.label}
    </Button>
  );
}

/**
 * Links, embeds and blocks, in one menu: their icons look alike in a row, and each is named here
 * in words. A word button, so no tooltip; one stop in the toolbar's arrow order.
 */
function InsertMenu(props: { onCloseAutoFocus: (e: Event) => void; children: React.ReactNode }) {
  const roving = useRovingItem('insert');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1 px-2 has-[>svg]:px-2"
          {...roving}
        >
          <Plus className="size-4" />
          Insert
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={props.onCloseAutoFocus}>
        {props.children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The divider between the toolbar's groups; drawn, not read. */
function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />;
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
  inTable: false,
  headerRow: false,
  canDeleteRow: false,
  canDeleteColumn: false,
  canUndo: false,
  canRedo: false,
};

/**
 * The table around the cursor: whether it leads with a row of header cells, and
 * whether the selected rows or columns can go. Removing every row or column is
 * deleting the table, which prosemirror-tables refuses only on dispatch — `can()`
 * reports true — so the rect is read here instead.
 */
function tableState(editor: Editor) {
  const { state } = editor;
  if (!isInTable(state)) {
    return { inTable: false, headerRow: false, canDeleteRow: false, canDeleteColumn: false };
  }
  const rect = selectedRect(state);
  const first = rect.table.firstChild;
  let headerRow = !!first && first.childCount > 0;
  first?.forEach((cell) => {
    if (cell.type.name !== 'tableHeader') headerRow = false;
  });
  return {
    inTable: true,
    headerRow,
    canDeleteRow: !(rect.top === 0 && rect.bottom === rect.map.height),
    canDeleteColumn: !(rect.left === 0 && rect.right === rect.map.width),
  };
}

/** Formatting toolbar for the rich-text editor. */
export function Toolbar(props: { editor: Editor; resolveEmbed?: () => EmbedResolver | undefined }) {
  const { editor } = props;
  const pickers = useContext(RichTextPickersContext);
  const [row, setRow] = useState<PickerRow>(null);
  const [href, setHref] = useState('');
  const [embedUrl, setEmbedUrl] = useState('');
  const embedUrlId = useId();
  const rowsRef = useRef<HTMLDivElement>(null);
  // A row opened from the toolbar takes focus, so its field is typed into straight away.
  const focusRow = useRef(false);
  // Where focus goes once the Insert menu closes on a choice: the editor, or the row it opened.
  const afterMenu = useRef<'editor' | 'row' | null>(null);

  // Before the editor is first focused its selection is a default at the document's start, not
  // the reader's: a document opening on a heading would show H1 pressed. The marks speak only
  // once there is (or was) a selection of theirs; undo and redo don't depend on it.
  const [engaged, setEngaged] = useState(() => editor.isFocused);
  useEffect(() => {
    if (engaged) return;
    const engage = () => setEngaged(true);
    editor.on('focus', engage);
    return () => {
      editor.off('focus', engage);
    };
  }, [editor, engaged]);

  // Re-render on selection/content changes so active states stay fresh.
  //
  // The selector can run in the window between the Editor instance existing and
  // its EditorView being attached — and again after destroy. `isActive` tolerates
  // that, but `can()` reaches into the view and throws
  // ("Cannot read properties of null"), which escapes to the router and replaces
  // the whole entry editor with an error page. It is intermittent, so it
  // surfaced as a flaky e2e rather than an obvious break.
  const selected = useEditorState({
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
        ...tableState(e),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      };
    },
  });

  const state = engaged
    ? selected
    : { ...IDLE_STATE, canUndo: selected.canUndo, canRedo: selected.canRedo };

  useEffect(() => {
    if (!row || !focusRow.current) return;
    focusRow.current = false;
    rowsRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [row]);

  // Acting from the toolbar takes the selection as it is: the marks speak from then on, without
  // waiting for the editor's focus (which Tiptap gives a frame later).
  const chain = () => {
    setEngaged(true);
    return editor.chain().focus();
  };
  const toggleRow = (next: Exclude<PickerRow, null>) => {
    focusRow.current = row !== next;
    setRow(row === next ? null : next);
  };

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
  // From the Insert menu: the row's field takes focus once the menu has gone (onCloseAutoFocus),
  // since the menu traps focus until then.
  const openRow = (next: Exclude<PickerRow, null>) => setRow(next);
  // Mark exclusivity (excludes in extensions.ts) clears any other link kind.
  const applyRefLink = (mark: 'entryLink' | 'assetLink', targetId: string) => {
    // extendMarkRange lets a collapsed cursor inside an existing link retarget it.
    chain().extendMarkRange(mark).setMark(mark, { targetId }).run();
    setRow(null);
  };
  // Only a URL an embed may hold enables the button; the row says which providers those are.
  const embedAccepted = embedFromUrl(embedUrl) !== undefined;
  const applyEmbed = () => {
    if (!insertExternalEmbed(editor, embedUrl, props.resolveEmbed?.())) return;
    setRow(null);
    setEmbedUrl('');
  };
  const insertInlineEntry = (targetId: string) => {
    chain().insertContent({ type: 'embeddedEntryInline', attrs: { targetId } }).run();
    setRow(null);
  };

  /** A choice in the Insert menu: runs, then says where focus lands when the menu has closed. */
  const choose = (run: () => void, focus: 'editor' | 'row' = 'editor') => {
    setEngaged(true);
    afterMenu.current = focus;
    run();
  };
  // The menu's own commands skip `focus()`: the menu still holds focus while they run, and
  // hands it on when it has closed (onCloseAutoFocus).
  const insert = () => editor.chain();

  return (
    <TooltipProvider>
      <div className="border-b">
        <RovingToolbar
          label="Text formatting"
          first="bold"
          // On a coarse pointer each 32px control's hit area grows to 44px: 12px apart (and 8px
          // from the edge), the grown areas meet without overlapping.
          className="flex flex-wrap items-center gap-0.5 p-1 touch:gap-3 touch:p-2"
        >
          <ToolbarButton
            id="bold"
            label="Bold"
            keys={EDITOR_KEYS.bold}
            active={state.bold}
            onClick={() => chain().toggleBold().run()}
          >
            <Bold className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="italic"
            label="Italic"
            keys={EDITOR_KEYS.italic}
            active={state.italic}
            onClick={() => chain().toggleItalic().run()}
          >
            <Italic className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="underline"
            label="Underline"
            keys={EDITOR_KEYS.underline}
            active={state.underline}
            onClick={() => chain().toggleUnderline().run()}
          >
            <Underline className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="strike"
            label="Strikethrough"
            keys={EDITOR_KEYS.strike}
            active={state.strike}
            onClick={() => chain().toggleStrike().run()}
          >
            <Strikethrough className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="code"
            label="Code"
            keys={EDITOR_KEYS.code}
            active={state.code}
            onClick={() => chain().toggleCode().run()}
          >
            <Code className="size-4" />
          </ToolbarButton>
          <ToolbarButton id="link" label="Link" active={state.link} onClick={toggleLink}>
            <Link2 className="size-4" />
          </ToolbarButton>

          <Divider />

          <ToolbarButton
            id="h1"
            label="Heading 1"
            keys={EDITOR_KEYS.h1}
            active={state.h1}
            onClick={() => chain().toggleHeading({ level: 1 }).run()}
          >
            <Heading1 className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="h2"
            label="Heading 2"
            keys={EDITOR_KEYS.h2}
            active={state.h2}
            onClick={() => chain().toggleHeading({ level: 2 }).run()}
          >
            <Heading2 className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="h3"
            label="Heading 3"
            keys={EDITOR_KEYS.h3}
            active={state.h3}
            onClick={() => chain().toggleHeading({ level: 3 }).run()}
          >
            <Heading3 className="size-4" />
          </ToolbarButton>

          <Divider />

          <ToolbarButton
            id="bulletList"
            label="Bullet list"
            keys={EDITOR_KEYS.bulletList}
            active={state.bulletList}
            onClick={() => chain().toggleBulletList().run()}
          >
            <List className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="orderedList"
            label="Ordered list"
            keys={EDITOR_KEYS.orderedList}
            active={state.orderedList}
            onClick={() => chain().toggleOrderedList().run()}
          >
            <ListOrdered className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="blockquote"
            label="Quote"
            keys={EDITOR_KEYS.blockquote}
            active={state.blockquote}
            onClick={() => chain().toggleBlockquote().run()}
          >
            <Quote className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="codeBlock"
            label="Code block"
            keys={EDITOR_KEYS.codeBlock}
            active={state.codeBlock}
            onClick={() => chain().toggleCodeBlock().run()}
          >
            <SquareCode className="size-4" />
          </ToolbarButton>

          <Divider />

          <InsertMenu
            onCloseAutoFocus={(e) => {
              const to = afterMenu.current;
              afterMenu.current = null;
              // Escape, or a click away: Radix returns focus to Insert, as a menu should.
              if (!to) return;
              e.preventDefault();
              if (to === 'editor') editor.commands.focus();
              else rowsRef.current?.querySelector<HTMLInputElement>('input')?.focus();
            }}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="caption">Link the selection</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() =>
                  state.entryLink
                    ? choose(() =>
                        insert().extendMarkRange('entryLink').unsetMark('entryLink').run(),
                      )
                    : choose(() => openRow('entryLink'), 'row')
                }
              >
                <FileSymlink />
                {state.entryLink ? 'Remove entry link' : 'Link to entry'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  state.assetLink
                    ? choose(() =>
                        insert().extendMarkRange('assetLink').unsetMark('assetLink').run(),
                      )
                    : choose(() => openRow('assetLink'), 'row')
                }
              >
                <FileImage />
                {state.assetLink ? 'Remove asset link' : 'Link to asset'}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="caption">Embed</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() =>
                  choose(() => insert().insertContent({ type: 'embeddedEntryBlock' }).run())
                }
              >
                <FileText />
                Embed entry
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => choose(() => openRow('inlineEntry'), 'row')}>
                <AtSign />
                Inline entry
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  choose(() => insert().insertContent({ type: 'embeddedAssetBlock' }).run())
                }
              >
                <Image />
                Embed asset
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => choose(() => openRow('embed'), 'row')}>
                <PlaySquare />
                Embed media
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="caption">Add</DropdownMenuLabel>
              <DropdownMenuItem
                // A table in a table is legal but never what this meant; the table row below
                // edits the one the cursor is in.
                disabled={state.inTable}
                onSelect={() =>
                  choose(() =>
                    insert().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
                  )
                }
              >
                <Table />
                Table
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => choose(() => insert().setHorizontalRule().run())}>
                <Minus />
                Horizontal rule
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </InsertMenu>

          <Divider />

          <ToolbarButton
            id="undo"
            label="Undo"
            keys={EDITOR_KEYS.undo}
            disabled={!state.canUndo}
            onClick={() => chain().undo().run()}
          >
            <Undo2 className="size-4" />
          </ToolbarButton>
          <ToolbarButton
            id="redo"
            label="Redo"
            keys={EDITOR_KEYS.redo}
            disabled={!state.canRedo}
            onClick={() => chain().redo().run()}
          >
            <Redo2 className="size-4" />
          </ToolbarButton>
        </RovingToolbar>

        <div ref={rowsRef}>
          {state.inTable && (
            <RovingToolbar
              label="Table"
              first="Row below"
              className="flex flex-wrap items-center gap-0.5 border-t p-1 touch:gap-3 touch:p-2"
            >
              <TableButton
                label="Row below"
                icon={BetweenHorizontalEnd}
                onClick={() => chain().addRowAfter().run()}
              />
              <TableButton
                label="Column right"
                icon={BetweenVerticalEnd}
                onClick={() => chain().addColumnAfter().run()}
              />
              <TableButton
                label="Header row"
                icon={PanelTop}
                pressed={state.headerRow}
                onClick={() => chain().toggleHeaderRow().run()}
              />
              <Divider />
              <TableButton
                label="Delete row"
                icon={Trash2}
                disabled={!state.canDeleteRow}
                onClick={() => chain().deleteRow().run()}
              />
              <TableButton
                label="Delete column"
                icon={Trash2}
                disabled={!state.canDeleteColumn}
                onClick={() => chain().deleteColumn().run()}
              />
              <TableButton
                label="Delete table"
                icon={Trash2}
                onClick={() => chain().deleteTable().run()}
              />
            </RovingToolbar>
          )}
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
          {row === 'embed' && (
            <div className="flex items-center gap-2 border-t p-2">
              <Input
                id={embedUrlId}
                className="h-8"
                aria-label="Media URL"
                aria-describedby={`${embedUrlId}-hint`}
                placeholder="https://www.youtube.com/watch?v=…"
                value={embedUrl}
                onChange={(e) => setEmbedUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyEmbed();
                  }
                }}
              />
              <span id={`${embedUrlId}-hint`} className="sr-only">
                {EMBED_PROVIDER_LIST}
              </span>
              <Button type="button" size="sm" disabled={!embedAccepted} onClick={applyEmbed}>
                Embed
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
      </div>
    </TooltipProvider>
  );
}
