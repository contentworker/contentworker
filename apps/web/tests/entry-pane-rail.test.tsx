// @vitest-environment jsdom
// The entry editor's side pane beside the assistant's column: where the row is too narrow to split,
// the pane folds to a rail of its views on the form's edge instead of stacking under the form, and
// opens over the form on demand.
import { TooltipProvider } from '@contentworker/ui/tooltip';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneRail } from '~/cms/components/pane/PaneRail';
import {
  MAIN_MIN_PX,
  PANE_MIN_PX,
  type PaneView,
  paneMode,
  usePaneLayout,
  usePanePeek,
} from '~/cms/components/pane/use-pane-layout';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BOTH = MAIN_MIN_PX + PANE_MIN_PX;

describe('paneMode', () => {
  it('splits wherever the row holds both, at any width', () => {
    expect(paneMode(BOTH, { railable: false })).toBe('split');
    expect(paneMode(BOTH, { railable: true })).toBe('split');
  });

  it('folds to the rail on a desktop-width screen whose row is too narrow to split', () => {
    expect(paneMode(BOTH - 1, { railable: true })).toBe('rail');
    expect(paneMode(524, { railable: true })).toBe('rail');
  });

  it('stacks below desktop width (phones, portrait tablets)', () => {
    expect(paneMode(BOTH - 1, { railable: false })).toBe('stack');
    expect(paneMode(358, { railable: false })).toBe('stack');
  });

  it('stacks before the row is measured, so the server draws what it always drew', () => {
    expect(paneMode(0, { railable: true })).toBe('stack');
  });
});

const LABELS: Record<PaneView, string> = {
  details: 'Details',
  preview: 'Preview',
  site: 'Site',
  activity: 'Activity',
};

/** The editor's row in miniature: the form, the rail when folded, and the pane. */
function Row({ railable, entry }: { railable: boolean; entry: string }) {
  const pane = usePaneLayout({ railable });
  const rail = pane.mode === 'rail';
  const [view, setView] = useState<PaneView>('details');
  const peek = usePanePeek({ rail, entry, view, onView: setView });
  return (
    <TooltipProvider>
      <div ref={pane.ref} data-mode={pane.mode}>
        <div data-testid="form" onPointerDown={peek.open ? () => peek.close(false) : undefined}>
          <input aria-label="Title" />
        </div>
        {rail ? (
          <div ref={peek.railRef}>
            <PaneRail
              views={['details', 'preview', 'activity']}
              view={view}
              open={peek.open}
              onPick={peek.pick}
              onKeyDown={peek.onKeyDown}
              labels={LABELS}
              controls="entry-pane"
            />
          </div>
        ) : null}
        <aside
          id="entry-pane"
          aria-label="Side pane"
          hidden={rail && !peek.open}
          onKeyDown={rail ? peek.onKeyDown : undefined}
        >
          <p>Showing {view}</p>
          <button type="button">Restore v1</button>
          {/* A menu the pane opened, portalled out of it as Radix's are. */}
          {createPortal(<button type="button">Menu item</button>, document.body)}
        </aside>
      </div>
    </TooltipProvider>
  );
}

function rowWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width,
    height: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

const pane = () => document.getElementById('entry-pane') as HTMLElement;

describe('the side pane beside the assistant', () => {
  it('stands as a rail of its views, the pane closed, instead of under the form', () => {
    rowWidth(576);
    render(<Row railable entry="e1" />);
    const rail = screen.getByRole('toolbar', { name: 'Side pane' });
    expect(rail.getAttribute('aria-orientation')).toBe('vertical');
    expect(screen.getAllByRole('button', { name: /Details|Preview|Activity/ })).toHaveLength(3);
    expect(pane().hidden).toBe(true);
  });

  it('keeps the old stacked pane without the assistant’s column', () => {
    rowWidth(576);
    const { container } = render(<Row railable={false} entry="e1" />);
    expect(container.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('stack');
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(pane().hidden).toBe(false);
  });

  it('splits, with no rail, where the row holds both', () => {
    rowWidth(BOTH + 200);
    const { container } = render(<Row railable entry="e1" />);
    expect(container.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('split');
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(pane().hidden).toBe(false);
  });

  it('opens the pane at the view pressed, and closes it when that view is pressed again', () => {
    rowWidth(576);
    render(<Row railable entry="e1" />);
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-pressed')).toBe('false');
    expect(details.getAttribute('aria-controls')).toBe('entry-pane');

    fireEvent.click(details);
    expect(pane().hidden).toBe(false);
    expect(details.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(details);
    expect(pane().hidden).toBe(true);
    expect(details.getAttribute('aria-pressed')).toBe('false');
  });

  it('switches view rather than closing when another view is pressed while open', () => {
    rowWidth(576);
    render(<Row railable entry="e1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByText('Showing activity')).toBeTruthy();
    expect(pane().hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Activity' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('closes on Escape from inside the pane and hands focus back to the view’s button', () => {
    rowWidth(576);
    render(<Row railable entry="e1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const restore = screen.getByRole('button', { name: 'Restore v1' });
    restore.focus();
    fireEvent.keyDown(restore, { key: 'Escape' });
    expect(pane().hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Details' }));
  });

  it('leaves Escape to a menu the pane portalled out of itself', () => {
    rowWidth(576);
    render(<Row railable entry="e1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Menu item' }), { key: 'Escape' });
    expect(pane().hidden).toBe(false);
  });

  it('steps aside when the form it covers is pressed', () => {
    rowWidth(576);
    render(<Row railable entry="e1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Title' }));
    expect(pane().hidden).toBe(true);
  });

  it('starts closed on another entry', () => {
    rowWidth(576);
    const { rerender } = render(<Row railable entry="e1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(pane().hidden).toBe(false);
    rerender(<Row railable entry="e2" />);
    expect(pane().hidden).toBe(true);
  });

  it('is one tab stop, the arrows moving between the views', () => {
    rowWidth(576);
    render(<Row railable entry="e1" />);
    const [details, preview, activity] = ['Details', 'Preview', 'Activity'].map((name) =>
      screen.getByRole('button', { name }),
    ) as [HTMLElement, HTMLElement, HTMLElement];
    expect([details.tabIndex, preview.tabIndex, activity.tabIndex]).toEqual([0, -1, -1]);
    details.focus();
    fireEvent.keyDown(details, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(preview);
    fireEvent.keyDown(preview, { key: 'ArrowUp' });
    fireEvent.keyDown(details, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(activity);
  });
});
