// What keeps an overlay usable on a phone: a sheet comes from the bottom there, and a dialog's
// actions stay in reach above an on-screen keyboard. Layout itself is proved in the device tests.
import {
  Dialog,
  DialogContent,
  DialogError,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentworker/ui/dialog';
import { keyboardInset } from '@contentworker/ui/lib/keyboard-inset';
import { Sheet, SheetTitle } from '@contentworker/ui/sheet';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveSheetContent } from '~/cms/components/responsive-sheet';

const matching = (matches: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query) =>
      ({
        matches: matches && query.includes('max-width: 639px'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
});

const sheet = () =>
  render(
    <Sheet open>
      <ResponsiveSheetContent aria-describedby={undefined}>
        <SheetTitle>Details</SheetTitle>
      </ResponsiveSheetContent>
    </Sheet>,
  );

describe('responsive sheet', () => {
  it('comes from the bottom on a phone', () => {
    matching(true);
    sheet();
    expect(screen.getByRole('dialog').getAttribute('data-side')).toBe('bottom');
  });

  it('comes from the side on anything wider', () => {
    matching(false);
    sheet();
    expect(screen.getByRole('dialog').getAttribute('data-side')).toBe('right');
  });
});

describe('dialog body', () => {
  it('scrolls the content but not the way out', () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>New thing</DialogTitle>
          </DialogHeader>
          <form>
            <DialogFooter>
              <button type="submit">Save</button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>,
    );
    const body = document.querySelector('[data-slot="dialog-body"]');
    expect(body?.contains(screen.getByRole('button', { name: 'Save' }))).toBe(true);
    // The close button stays outside what scrolls, so it can't scroll away.
    expect(body?.contains(screen.getByRole('button', { name: 'Close' }))).toBe(false);
  });
});

describe('dialog error', () => {
  it('is heard at once, and brings itself into view above the pinned footer', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    render(<DialogError title="Nothing was imported">Row 3 has no source.</DialogError>);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('Nothing was importedRow 3 has no source.');
    expect(alert.className).toContain('text-destructive');
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

describe('keyboard inset', () => {
  const viewport = (height: number, scale = 1) => {
    const listeners: (() => void)[] = [];
    const vv = {
      height,
      scale,
      offsetTop: 0,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    return {
      vv,
      fire: () => {
        for (const fn of listeners) fn();
      },
    };
  };

  it('follows what the keyboard covers, and stops when the overlay goes', () => {
    const { vv, fire } = viewport(window.innerHeight);
    const el = document.createElement('div');
    const release = keyboardInset(el);
    expect(el.style.getPropertyValue('--keyboard-inset')).toBe('0px');

    vv.height = window.innerHeight - 300;
    fire();
    expect(el.style.getPropertyValue('--keyboard-inset')).toBe('300px');

    release?.();
    expect(vv.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('reads a pinch-zoomed viewport as no keyboard', () => {
    viewport(window.innerHeight - 300, 2);
    const el = document.createElement('div');
    keyboardInset(el);
    expect(el.style.getPropertyValue('--keyboard-inset')).toBe('0px');
  });
});
