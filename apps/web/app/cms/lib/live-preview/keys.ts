/**
 * A shortcut pressed in the Site pane's page, acted on as if pressed in the editor: the page keeps
 * focus, so the key is replayed on the form field last in use (or the page), where the editor's
 * own handlers hear it. Undo and redo, which a browser runs only in a focused field, take focus
 * back to that field when no handler took them.
 */
import type { FrameKey } from './frame-channel';

export function replayKey(k: FrameKey, target: Element | null | undefined): void {
  const el = target?.isConnected ? target : document.body;
  const event = new KeyboardEvent('keydown', {
    key: k.key,
    metaKey: k.meta,
    ctrlKey: k.ctrl,
    shiftKey: k.shift,
    altKey: k.alt,
    bubbles: true,
    cancelable: true,
  });
  const handled = !el.dispatchEvent(event);
  if (handled || k.key !== 'z' || !(k.meta || k.ctrl) || !editable(el)) return;
  (el as HTMLElement).focus();
  document.execCommand?.(k.shift ? 'redo' : 'undo');
}

function editable(el: Element): boolean {
  return (el as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName);
}
