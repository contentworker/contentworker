/**
 * Who wrote an entry, as a person reads it. The api records an actor id (`createdBy`,
 * `updatedBy`): a person's id, the admin token, an API key's kind, or what acted on nobody's
 * keystroke (`agent:<name>`, `workflow:<id>`, `plugin:<id>`, `system`). This turns one into words,
 * never showing a raw id: a teammate by name when the team is known (only administrators can read
 * it), "You" for the signed-in person, else what kind of writer it was.
 */

export interface ActorDirectory {
  /** The signed-in person's id (`subject`), so their own entries read "You". */
  readonly me?: string;
  readonly people?: readonly {
    readonly id: string;
    readonly email: string;
    readonly name?: string;
  }[];
}

const KEY_KINDS = new Set(['cma', 'cda', 'cpa', 'api_key']);

/** An actor id in words; `null` (not recorded) reads "Unknown". */
export function actorLabel(
  actor: string | null | undefined,
  directory: ActorDirectory = {},
): string {
  if (!actor) return 'Unknown';
  if (directory.me && actor === directory.me) return 'You';
  const person = directory.people?.find((p) => p.id === actor);
  if (person) return person.name?.trim() || person.email;
  if (actor === 'admin-token' || actor === 'admin') return 'The admin token';
  if (KEY_KINDS.has(actor)) return 'An API key';
  if (actor === 'system') return 'A schedule';
  if (actor.startsWith('agent:')) return `The ${actor.slice('agent:'.length)} agent`;
  if (actor.startsWith('workflow:')) return 'A workflow';
  if (actor.startsWith('plugin:')) return 'A plugin';
  // An email recorded as itself reads fine; any other id is a teammate the reader can't look up.
  return actor.includes('@') ? actor : 'A teammate';
}
