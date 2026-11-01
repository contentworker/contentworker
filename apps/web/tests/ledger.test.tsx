// Ledger in the CMS screens: the primitives never fade a control through low contrast, the
// stylesheet carries the tokens the ported screens use, statuses read in words as well as colour,
// and tables stack on a phone. (Palette parity with @contentworker/design is packages/design's.)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@contentworker/ui/table';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge, ToneBadge } from '~/cms/components/status';
import { ago, countLabel, statusLabel, statusTone } from '~/cms/lib/format';

// The stylesheet as text (Vite's ?raw comes back empty under vitest's CSS handling).
const css = readFileSync(join(process.cwd(), 'app/app.css'), 'utf8');

// The UI primitives' source, to check what their transitions animate.
const primitives = import.meta.glob('../../../packages/ui/src/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('UI primitives', () => {
  it('never fade a control through low contrast: a disabled state never animates opacity', () => {
    const offenders = Object.entries(primitives)
      .filter(([, src]) => src.includes('disabled:opacity'))
      // On the element itself; a pseudo-element's own fade (`after:transition-opacity`, a tab's
      // underline) never carries the control's text.
      .filter(([, src]) =>
        /(?<![\w:-])transition-(?:all|opacity)\b|(?<![\w:-])transition-\[[^\]]*opacity/.test(src),
      )
      .map(([file]) => file);
    expect(offenders).toEqual([]);
    expect(Object.keys(primitives).length).toBeGreaterThan(10);
  });
});

describe('Ledger tokens in app.css', () => {
  it('defines the motion tokens and state variants the CMS screens and primitives use', () => {
    for (const t of ['--motion-instant', '--motion-move', '--motion-travel', '--ease-arrive'])
      expect(css).toContain(`${t}:`);
    for (const v of ['data-open', 'data-closed', 'data-checked', 'data-active', 'data-horizontal'])
      expect(css).toContain(`@custom-variant ${v} {`);
    expect(css).toContain('.rich-text-editor');
    expect(css).toContain('--color-cat-content');
  });

  it('defines every status token in light and dark', () => {
    const [light, dark] = css.split(':root[data-theme="dark"]');
    for (const t of ['ok', 'wait', 'bad', 'undo', 'idle', 'brand']) {
      expect(light).toMatch(new RegExp(`--${t}: oklch`));
      expect(dark).toMatch(new RegExp(`--${t}: oklch`));
    }
    // Run is the work blue in both themes; a model's work is the brand, and so is focus.
    expect(light).toContain('--run: var(--link);');
    expect(light).toContain('--ai: var(--brand);');
    expect(light).toContain('--ring: var(--brand);');
  });
});

describe('status vocabulary', () => {
  it("maps contentworker's statuses onto one meaning each", () => {
    expect(statusTone('published')).toBe('ok');
    expect(statusTone('changed')).toBe('wait');
    expect(statusTone('scheduled')).toBe('run');
    expect(statusTone('draft')).toBe('idle');
    expect(statusTone('archived')).toBe('idle');
    expect(statusTone('revoked')).toBe('idle');
    expect(statusTone('failed')).toBe('bad');
    expect(statusTone('proposed')).toBe('ai');
    expect(statusTone('something-new')).toBe('idle');
    expect(statusLabel('in_review')).toBe('In review');
    expect(countLabel(100)).toBe('99+');
    expect(ago(Date.now() - 3 * 60_000)).toBe('3m ago');
  });

  it('tints a status and rules a bad ending, in words as well as colour', () => {
    render(
      <>
        <StatusBadge status="published" />
        <StatusBadge status="failed" />
        <ToneBadge tone="wait" label="Unsaved changes" />
      </>,
    );
    const ok = screen.getByText('Published');
    expect(ok.getAttribute('style')).toContain('var(--ok)');
    expect(ok.getAttribute('style')).toContain('color-mix');
    const bad = screen.getByText('Failed');
    expect(bad.getAttribute('style')).toContain('border-color: var(--bad)');
    expect(screen.getByText('Unsaved changes').getAttribute('style')).toContain('var(--wait)');
  });
});

describe('Table', () => {
  it('stacks into cards on a phone, labelling every cell but the first', () => {
    render(
      <Table stack="cards" caption="Keys">
        <TableHead>
          <Tr>
            <Th>Name</Th>
            <Th numeric>Uses</Th>
          </Tr>
        </TableHead>
        <TableBody>
          <Tr>
            <Td>dev-cma</Td>
            <Td label="Uses" numeric>
              12
            </Td>
          </Tr>
        </TableBody>
      </Table>,
    );
    const table = screen.getByRole('table', { name: 'Keys' });
    expect(table.className).toContain('table-stack');
    // Explicit roles survive the phone layout, which drops them in WebKit otherwise.
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByRole('columnheader', { name: 'Uses' }).className).toContain(
      'text-right',
    );
    expect(within(table).getByRole('cell', { name: '12' }).dataset.label).toBe('Uses');
  });
});
