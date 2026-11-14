/**
 * The rich-text editor's keys, as Tiptap's own keymaps bind them (StarterKit 3: bold, italic,
 * underline, strike, code, heading, lists, blockquote, code block, undo-redo). One table feeds
 * the toolbar's tooltips and the "?" list, so neither can name a key the editor doesn't answer.
 * Link has none: ⌘K is the command palette's everywhere, the editor included.
 */
import type { ShortcutGroup } from '~/cms/lib/shortcuts';

/** A chord, held together. `Mod` is ⌘ on Apple devices and Ctrl elsewhere. */
export type Chord = readonly ('Mod' | 'Shift' | 'Alt' | string)[];

export const EDITOR_KEYS = {
  bold: ['Mod', 'B'],
  italic: ['Mod', 'I'],
  underline: ['Mod', 'U'],
  strike: ['Mod', 'Shift', 'S'],
  code: ['Mod', 'E'],
  h1: ['Mod', 'Alt', '1'],
  h2: ['Mod', 'Alt', '2'],
  h3: ['Mod', 'Alt', '3'],
  bulletList: ['Mod', 'Shift', '8'],
  orderedList: ['Mod', 'Shift', '7'],
  blockquote: ['Mod', 'Shift', 'B'],
  codeBlock: ['Mod', 'Alt', 'C'],
  undo: ['Mod', 'Z'],
  redo: ['Mod', 'Shift', 'Z'],
} as const satisfies Record<string, Chord>;

/** Apple's modifier order (⌥⇧⌘) and glyphs, run together: "⇧⌘S". */
const APPLE_GLYPH: Record<string, string> = { Alt: '⌥', Shift: '⇧', Mod: '⌘' };
const APPLE_ORDER = ['Alt', 'Shift', 'Mod'];

/** A chord as a tooltip prints it: "⇧⌘S" on Apple devices, "Ctrl+Shift+S" elsewhere. */
export function chordLabel(keys: Chord, apple: boolean): string {
  if (!apple) return keys.map((k) => (k === 'Mod' ? 'Ctrl' : k)).join('+');
  const mods = APPLE_ORDER.filter((m) => keys.includes(m)).map((m) => APPLE_GLYPH[m]);
  const rest = keys.filter((k) => !APPLE_ORDER.includes(k));
  return [...mods, ...rest].join('');
}

/** `aria-keyshortcuts` for both platforms, as the shell's own controls give it. */
export function ariaKeyShortcuts(keys: Chord): string {
  const as = (mod: string) => keys.map((k) => (k === 'Mod' ? mod : k)).join('+');
  return `${as('Meta')} ${as('Control')}`;
}

const sheetItems = (alt: string): ShortcutGroup['items'] => {
  const chord = (keys: Chord, label: string) => ({
    keys: keys.map((k) => (k === 'Alt' ? alt : k)),
    chord: true,
    label,
  });
  return [
    chord(['Mod', 'S'], 'Save draft'),
    chord(EDITOR_KEYS.bold, 'Bold'),
    chord(EDITOR_KEYS.italic, 'Italic'),
    chord(EDITOR_KEYS.underline, 'Underline'),
    chord(EDITOR_KEYS.strike, 'Strikethrough'),
    chord(EDITOR_KEYS.code, 'Code'),
    chord(['Mod', 'Alt', '1–6'], 'Heading 1 to 6'),
    chord(EDITOR_KEYS.bulletList, 'Bullet list'),
    chord(EDITOR_KEYS.orderedList, 'Ordered list'),
    chord(EDITOR_KEYS.blockquote, 'Quote'),
    chord(EDITOR_KEYS.codeBlock, 'Code block'),
    chord(EDITOR_KEYS.undo, 'Undo'),
    chord(EDITOR_KEYS.redo, 'Redo'),
    // The toolbar is one Tab stop; arrows move within it.
    { keys: ['←'], label: 'Previous control in the toolbar' },
    { keys: ['→'], label: 'Next control in the toolbar' },
    { keys: ['Home'], label: 'First control in the toolbar' },
    { keys: ['End'], label: 'Last control in the toolbar' },
  ];
};

/**
 * The "Editor" group of the "?" list, while a rich-text field is on the page. Two constants (the
 * Option key is ⌥ on a Mac's keycap, Alt elsewhere) so registering one never re-runs per render.
 */
export const EDITOR_SHORTCUTS_APPLE: ShortcutGroup = {
  id: 'rich-text-editor',
  title: 'Editor',
  items: sheetItems('⌥'),
};
export const EDITOR_SHORTCUTS: ShortcutGroup = {
  id: 'rich-text-editor',
  title: 'Editor',
  items: sheetItems('Alt'),
};
