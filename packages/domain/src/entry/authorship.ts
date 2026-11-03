import type { Entry } from './entry';

/**
 * Who wrote an entry, as its authorship records it. A request's actor is its principal's audit
 * identity (`principalActorId`: a person's subject, `admin-token`, or the API key's kind); work
 * nobody asked for in that request names what did it instead. Kept as plain strings so an id the
 * store holds never has to be parsed back.
 */
export type EntryActor = string;

/** Engine work no principal asked for in the moment: a scheduled publish, a release's schedule. */
export const SYSTEM_ACTOR: EntryActor = 'system';

/** An editorial agent's writes (`enrich`, `curate`, `moderate`). */
export const agentActor = (agent: string): EntryActor => `agent:${agent}`;

/** A workflow node's writes, named for the workflow rather than the person it acts for. */
export const workflowActor = (workflowId: string): EntryActor => `workflow:${workflowId}`;

/** A plugin's writes through its capabilities, as the audit log names a plugin. */
export const pluginActor = (pluginId: string): EntryActor => `plugin:${pluginId}`;

/**
 * A new entry's authorship: created (and last changed) by `actor` at `at`. An entry carried over
 * from elsewhere (an environment clone, a promotion) keeps the authorship it brings.
 */
export function stampCreated(entry: Entry, actor: EntryActor | null, at: string): Entry {
  return {
    ...entry,
    createdAt: entry.createdAt ?? at,
    createdBy: entry.createdBy !== undefined ? entry.createdBy : actor,
    updatedBy: actor,
    firstPublishedAt: entry.firstPublishedAt ?? null,
  };
}

/** Any later change (a save, an unpublish, the trash): `actor` made it. */
export function stampChanged(entry: Entry, actor: EntryActor | null): Entry {
  return { ...entry, updatedBy: actor };
}

/**
 * A publish of `before` (the entry as it was read): `actor` made it, and it is the first unless
 * one is recorded. An entry already live with none recorded went live before first publishes were
 * recorded, so its first stays unknown rather than becoming this one.
 */
export function stampPublished(
  before: Entry,
  published: Entry,
  actor: EntryActor | null,
  at: string,
): Entry {
  const first = before.firstPublishedAt ?? (before.publishedVersion === null ? at : null);
  return { ...published, updatedBy: actor, firstPublishedAt: first };
}
