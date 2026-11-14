/**
 * Names an embed's target when the pickers' capped first page doesn't hold it. Looked up through
 * the pickers' own `resolve` (the lookup a list of links uses), once per id per resolver: every
 * embed asking in the same tick goes in one request, and an answer is kept for the next embed and
 * the next render. A failed lookup is forgotten, so the next mount asks again.
 */
import { useEffect, useState } from 'react';
import type { Pickers, PickOption } from '../EntryForm';

type LinkType = 'Entry' | 'Asset';
type Resolve = NonNullable<Pickers['resolve']>;
type Lookup = (linkType: LinkType, id: string) => Promise<PickOption | null>;

/** One cache per resolver: the pickers make a new one only when their lists change. */
const lookups = new WeakMap<Resolve, Lookup>();

function lookupFor(resolve: Resolve): Lookup {
  const known = lookups.get(resolve);
  if (known) return known;
  const answers = new Map<string, Promise<PickOption | null>>();
  const waiting = new Map<LinkType, Map<string, (o: Promise<PickOption | null>) => void>>();
  const flush = (linkType: LinkType) => {
    const batch = waiting.get(linkType);
    waiting.delete(linkType);
    if (!batch) return;
    const found = resolve(linkType, [...batch.keys()]);
    for (const [id, settle] of batch) {
      const one = found.then((options) => options.find((o) => o.id === id) ?? null);
      one.catch(() => answers.delete(`${linkType}:${id}`));
      settle(one);
    }
  };
  const lookup: Lookup = (linkType, id) => {
    const key = `${linkType}:${id}`;
    const cached = answers.get(key);
    if (cached) return cached;
    const answer = new Promise<PickOption | null>((settle) => {
      let batch = waiting.get(linkType);
      if (!batch) {
        batch = new Map();
        waiting.set(linkType, batch);
        queueMicrotask(() => flush(linkType));
      }
      batch.set(id, settle);
    });
    answers.set(key, answer);
    return answer;
  };
  lookups.set(resolve, lookup);
  return lookup;
}

export type LinkTarget =
  | { readonly status: 'empty' }
  | { readonly status: 'loading' }
  | { readonly status: 'found'; readonly option: PickOption }
  /** Gone (deleted, or never in this environment), or nothing to ask. */
  | { readonly status: 'missing' }
  | { readonly status: 'failed' };

/** What an embed points at: from the picker's list, else looked up, never just its id. */
export function useLinkTarget(linkType: LinkType, id: string, pickers: Pickers): LinkTarget {
  const list = linkType === 'Asset' ? pickers.assets : pickers.entries;
  const listed = id ? list.find((o) => o.id === id) : undefined;
  const { resolve } = pickers;
  const [answer, setAnswer] = useState<{ id: string; option: PickOption | null | 'failed' }>();

  const ask = !!id && !listed && !!resolve;
  useEffect(() => {
    if (!ask || !resolve) return;
    let live = true;
    lookupFor(resolve)(linkType, id).then(
      (option) => live && setAnswer({ id, option }),
      () => live && setAnswer({ id, option: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [ask, resolve, linkType, id]);

  if (!id) return { status: 'empty' };
  if (listed) return { status: 'found', option: listed };
  if (!resolve) return { status: 'missing' };
  if (answer?.id !== id) return { status: 'loading' };
  if (answer.option === 'failed') return { status: 'failed' };
  return answer.option ? { status: 'found', option: answer.option } : { status: 'missing' };
}

/**
 * The name to show: an entry's title, else "Untitled entry" (its option's label would be its id);
 * an asset's label is its title or file name.
 */
export function targetName(linkType: LinkType, option: PickOption): string {
  if (linkType === 'Asset') return option.title ?? option.label;
  return option.title ?? 'Untitled entry';
}
