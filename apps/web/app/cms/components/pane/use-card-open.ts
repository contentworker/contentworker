import { useCallback, useLayoutEffect, useState } from 'react';

const KEY = (name: string) => `cw.entry-pane.card.${name}`;

function readOpen(name: string): boolean | null {
  try {
    const kept = localStorage.getItem(KEY(name));
    return kept === 'open' ? true : kept === 'closed' ? false : null;
  } catch {
    return null;
  }
}

function writeOpen(name: string, open: boolean, defaultOpen: boolean) {
  try {
    // Only a choice that differs from the card's default is kept, so a default that moves later
    // reaches everyone who never touched the card.
    if (open === defaultOpen) localStorage.removeItem(KEY(name));
    else localStorage.setItem(KEY(name), open ? 'open' : 'closed');
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
}

/**
 * Whether one of the side pane's cards is open, remembered per browser under `name` (how this
 * person likes the pane, not a fact about the entry). The server can't read storage, so it draws
 * the default and the kept choice arrives before the first paint after hydration, as the pane's
 * view and share do.
 */
export function useCardOpen(
  name: string | undefined,
  defaultOpen: boolean,
): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(defaultOpen);
  useLayoutEffect(() => {
    if (!name) return;
    const kept = readOpen(name);
    if (kept !== null) setOpenState(kept);
  }, [name]);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      if (name) writeOpen(name, next, defaultOpen);
    },
    [name, defaultOpen],
  );
  return [open, setOpen];
}
