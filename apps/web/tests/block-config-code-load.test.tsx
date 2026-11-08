// @vitest-environment jsdom
// The block config's code views fetch CodeMirror when they open: while it comes they say so once
// and stand a skeleton in, and a fetch that fails says so in place, once for the view, with Try
// again, which fetches it anew (a failed fetch isn't kept). Its own file: the editor module's mock
// fails the first import, and a module loads once per file.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlaceCode } from '~/cms/lib/block-config-code';
import type { Place } from '~/cms/lib/block-config-draft';

const fetches = vi.hoisted(() => ({ count: 0 }));
vi.mock('~/cms/components/block-config/codemirror', () => {
  fetches.count += 1;
  if (fetches.count === 1) throw new Error('Failed to fetch dynamically imported module');
  return {
    JsonCode: (p: { value: string; label: string }) => (
      <textarea readOnly aria-label={p.label} value={p.value} />
    ),
    JsonDiff: (p: { unifiedLabel: string }) => <fieldset aria-label={p.unifiedLabel} />,
  };
});

const { BlockConfigCode, BlockConfigDiff } = await import(
  '~/cms/components/block-config/code-views'
);

afterEach(cleanup);

const place = (key: string): Place => ({
  kind: 'slot',
  key,
  block: 'grid',
  slot: key,
  code: { allowed: ['card'] },
});
const narrowed = (key: string): PlaceCode => ({
  place: place(key),
  code: '{\n  "locked": false\n}',
  inForce: '{\n  "locked": true\n}',
  narrowed: true,
  changed: ['locked'],
  ignored: [],
});

describe('fetching the code view', () => {
  it('says a failed fetch once, and Try again fetches it anew', async () => {
    render(
      <BlockConfigDiff
        list={[narrowed('items'), narrowed('aside')]}
        elsewhere={[]}
        placeName={(p) => `Grid › ${p.key}`}
        unsaved={false}
      />,
    );
    expect(await screen.findByText('The code view couldn’t be loaded')).toBeTruthy();
    // One for the view, not one per place.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('group', {
        name: 'The rule in force for Grid › items, with the code’s lines it replaces, as JSON',
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole('group')).toHaveLength(2);
    expect(screen.queryByText('The code view couldn’t be loaded')).toBeNull();
    expect(fetches.count).toBe(2);
  });

  it('keeps the fetched editor for the next view', async () => {
    render(<BlockConfigCode text="{}" unsaved={false} invalid={false} version={0} ignored={0} />);
    expect(await screen.findByRole('textbox', { name: 'Block config as JSON' })).toBeTruthy();
    expect(fetches.count).toBe(2);
  });
});
