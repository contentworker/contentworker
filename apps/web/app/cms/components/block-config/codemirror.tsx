/**
 * CodeMirror for the block config as code: a read-only JSON view and a diff of the code's rule
 * against the one in force. Loaded only when the Code or Narrowed from code view opens
 * (`code-views.tsx` imports this module dynamically), so no other route, and not /blocks until then,
 * ships an editor.
 *
 * Ledger's look, from the page's own CSS tokens, so it follows the theme as the page does: ink on
 * the code block's muted fill, Plex Mono, line numbers in muted ink. Syntax is told apart by weight
 * and grey only, since colour means status (The One Meaning Rule). A diff is tinted as the entry's
 * revision diff is (`bad` for the code's side, `ok` for the rule in force) and every changed line
 * also carries its sign, − or +, in a gutter, so it never rests on colour.
 */
import { json } from '@codemirror/lang-json';
import { foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { getChunks, MergeView, unifiedMergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

const tint = (token: string, percent: number) =>
  `color-mix(in oklch, var(--${token}) ${percent}%, transparent)`;

const ledger = EditorView.theme({
  '&': {
    color: 'var(--foreground)',
    backgroundColor: 'transparent',
    fontSize: 'var(--text-xs, 0.75rem)',
  },
  // The frame (a code block) draws the focus ring; side by side, the pane with focus is ringed too.
  '&.cm-focused': { outline: 'none' },
  '.cm-mergeView &.cm-focused': { boxShadow: 'inset 0 0 0 1px var(--ring)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.625' },
  '.cm-content': { padding: '0.75rem 0', caretColor: 'var(--brand)' },
  '.cm-line': { padding: '0 1rem 0 0.25rem' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--muted-foreground)',
    border: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.25rem 0 0.75rem', minWidth: '2.25rem' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 0.25rem', cursor: 'pointer' },
  // A finger needs more than one character's width to fold with.
  '@media (pointer: coarse)': {
    '.cm-foldGutter .cm-gutterElement': { minWidth: '1.5rem', textAlign: 'center' },
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--muted)',
    border: '1px solid var(--rule)',
    color: 'var(--muted-foreground)',
    borderRadius: 'var(--radius-sm)',
    padding: '0 0.375rem',
    margin: '0 0.25rem',
  },
  // The diff: the code's side in `bad`, the rule in force in `ok`, as the revision diff has it.
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { backgroundColor: tint('bad', 10) },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': { backgroundColor: tint('ok', 10) },
  '&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText': {
    background: 'none',
    textDecoration: 'line-through',
    textDecorationColor: 'var(--bad)',
    textDecorationThickness: '2px',
  },
  '&.cm-merge-b .cm-changedText': {
    background: 'none',
    textDecoration: 'underline',
    textDecorationColor: 'var(--ok)',
    textDecorationThickness: '2px',
    textUnderlineOffset: '3px',
  },
  '.cm-deletedChunk': { paddingLeft: '0.25rem' },
  '.cm-diffSigns .cm-gutterElement': { padding: '0 0.25rem', fontWeight: '600' },
  '.cm-diffSign-add': { color: 'var(--ok)' },
  '.cm-diffSign-remove': { color: 'var(--bad)' },
});

/** JSON in greys: keys a step heavier than values, punctuation in muted ink. */
const ledgerJson = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--foreground)', fontWeight: '500' },
  { tag: [t.string, t.number, t.bool, t.null], color: 'var(--foreground)' },
  {
    tag: [t.punctuation, t.separator, t.brace, t.squareBracket],
    color: 'var(--muted-foreground)',
  },
]);

/** Read-only, but focusable: the keyboard can move through it, select and fold. */
function base(label: string, describedBy?: string): Extension[] {
  return [
    ledger,
    json(),
    syntaxHighlighting(ledgerJson),
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.contentAttributes.of({
      'aria-label': label,
      ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    }),
  ];
}

class Sign extends GutterMarker {
  constructor(readonly sign: '+' | '−') {
    super();
  }
  override eq(other: Sign) {
    return other.sign === this.sign;
  }
  override toDOM() {
    const el = document.createElement('span');
    el.className = this.sign === '+' ? 'cm-diffSign-add' : 'cm-diffSign-remove';
    el.textContent = this.sign;
    return el;
  }
}
const ADD = new Sign('+');
const REMOVE = new Sign('−');

/**
 * − beside each of the code's changed lines and + beside each of the rule in force's; in a unified
 * view, − beside each block of the code's lines shown over the new ones.
 */
const signs = gutter({
  class: 'cm-diffSigns',
  lineMarker(view, line) {
    const found = getChunks(view.state);
    if (!found) return null;
    const a = found.side === 'a';
    for (const c of found.chunks) {
      const [from, to, end] = a ? [c.fromA, c.toA, c.endA] : [c.fromB, c.toB, c.endB];
      if (to > from && line.from >= from && line.from <= end) return a ? REMOVE : ADD;
    }
    return null;
  },
  // The only block widgets here are the unified view's deleted chunks.
  widgetMarker: () => REMOVE,
  lineMarkerChange: () => true,
  initialSpacer: () => ADD,
});

/** The block config as read-only JSON, with line numbers and folding. */
export function JsonCode({
  value,
  label,
  describedBy,
}: {
  value: string;
  label: string;
  /** The id of what says whose rules these are (in force, or unsaved). */
  describedBy?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Made once; the text follows `value` in the next effect, so folds and the scroll survive a
  // refetch or an edit in the Rules view.
  useEffect(() => {
    if (!host.current) return;
    view.current = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [...base(label, describedBy), foldGutter(), keymap.of(foldKeymap)],
      }),
    });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, [label, describedBy]);
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);
  return <div ref={host} data-testid="json-code" />;
}

/**
 * The code's rule against the one in force: side by side (`split`, the code's on the left) where
 * there is room, or one column with the code's lines over the ones that replace them (`unified`).
 */
export function JsonDiff(props: {
  code: string;
  inForce: string;
  layout: 'split' | 'unified';
  codeLabel: string;
  inForceLabel: string;
  unifiedLabel: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { code, inForce, layout, codeLabel, inForceLabel, unifiedLabel } = props;
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    if (layout === 'split') {
      const merge = new MergeView({
        parent,
        a: { doc: code, extensions: [...base(codeLabel), signs] },
        b: { doc: inForce, extensions: [...base(inForceLabel), signs] },
        gutter: false,
      });
      return () => merge.destroy();
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: inForce,
        extensions: [
          ...base(unifiedLabel),
          signs,
          unifiedMergeView({ original: code, mergeControls: false, gutter: false }),
        ],
      }),
    });
    return () => view.destroy();
  }, [code, inForce, layout, codeLabel, inForceLabel, unifiedLabel]);
  return <div ref={host} data-testid="json-diff" />;
}
