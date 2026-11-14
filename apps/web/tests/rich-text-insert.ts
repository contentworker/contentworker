/**
 * The rich-text toolbar's Insert menu, driven as a pointer drives it: Radix opens a menu on a
 * primary-button pointer press, and a menu item runs on click. Shared by the rich-text dom tests.
 */
import { act, fireEvent, screen } from '@testing-library/react';

/** Opens Insert and returns the menu. */
export async function openInsertMenu(): Promise<HTMLElement> {
  await act(async () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Insert' }), {
      button: 0,
      ctrlKey: false,
    });
  });
  return screen.findByRole('menu');
}

/** Opens Insert and picks an item by name; the menu hands focus on once it has closed. */
export async function chooseInsert(name: string): Promise<void> {
  await openInsertMenu();
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name }));
  });
  // Radix closes the menu and hands focus on (onCloseAutoFocus) after a tick.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Closes an open menu as Escape does. */
export async function closeMenu(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  });
}
