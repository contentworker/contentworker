# Locked regions

Status: **proposed** (M6, "Locked regions on the canvas" in `ROADMAP.md`). Nothing here is built.
This file sits in `docs/specs/`, which the docs embed does not read (it takes `docs/*.md` only),
so MCP clients never mistake it for a description of shipped behaviour.

## What it is

A locked region is part of one entry's blocks that editors can't restructure: one block and
everything inside it, or a run of neighbouring blocks in one slot. Someone allowed to lock
selects it on the canvas and picks Lock; after that, nobody can add, remove, move or swap blocks
in the region until someone allowed to unlock it does.

It answers "this page's legal footer and hero stay as approved, the rest of the page is open".
The block config's `locked` (#195) can't say that: it is a schema rule, true of a slot on every
entry of a content type. A region is content: it belongs to one entry.

## What is already in place

- **Slot locks** (`packages/domain/src/content-type/block-config.ts`): a slot locked in the block
  config refuses a save that changes its sequence of blocks (`slot_locked`). What is inside the
  blocks stays editable.
- **One check on every write path.** `assertBlockConfigAllows`
  (`packages/application/src/block-config.ts`) runs from `prepareFields` on new edits, imports
  included, over REST, MCP and Coworker's `patchBlocks` alike. Copies (snapshot restore, clone,
  promotion, duplicate, version restore) are not judged.
- **Stable identity.** Every block carries a `_key` that survives moves, so a lock can name
  blocks by key rather than by position.
- **The canvas and the form honour a locked slot**: no seams, no move, duplicate or remove, and
  Layers shows the lock.

## Options considered

**A. Lock by block type.** A block declares `lock: 'subtree'` in code (or an admin sets it in
Build → Blocks), and every instance of it, with everything inside, is fixed. Cheap: a recursive
slot lock. But it is true of every instance, so it can't lock a run of blocks, or one page's hero
and not another's. Much of it is already possible by locking each of a block's slots.

**B. Lock regions per entry (proposed).** Locks are stored on the entry, keyed by `_key`, and
checked by the same code that checks slot locks. The rest of this spec describes B.

**C. Locked patterns.** A saved group of blocks inserted as one locked unit, with Detach. This is
reusable sections with a lock property; it belongs with that feature, later, and would use B's
lock underneath.

A may follow B if someone asks for type-wide subtree locks. C waits for reusable sections.

## The model

```ts
interface BlockLock {
  /** The blocks field (a top-level field apiId) the region is in. */
  readonly field: string;
  /** The region: one block, or a run of neighbours in one slot, in order, by `_key`. */
  readonly keys: readonly string[];
  /** `subtree`: the blocks and everything inside them. `self`: their own slots stay open. */
  readonly depth: 'subtree' | 'self';
  /** Who locked it and when, from the principal and `ctx.clock`. */
  readonly lockedBy: string;
  readonly lockedAt: string;
}
```

- Stored on the entry beside its fields, not inside them: a new `block_locks` JSON column on
  `entries` (expand-only migration), read and written with the entry. Field values stay pure
  content, so delivery, webhooks and exports never see a lock.
- **Run, not set.** `keys` are neighbours in one slot, in order. The check holds them together:
  nothing may be inserted between them, removed from them or reordered within them. The run as a
  whole may move only if the region is not itself inside a locked slot or region.
- **One region per block.** A block belongs to at most one region; overlapping locks are refused
  when made (422 `lock_overlaps`).
- Locks are entry state, not versioned content: locking or unlocking is its own operation, not a
  save of the fields, and does not create a version. (Open question 5.)

## Enforcement

`blockConfigIssues` gains the regions held on the stored entry as one more input. Before and after
compared, with each issue naming the region's first `_key`:

| Change                                                     | Issue                         |
| ---------------------------------------------------------- | ----------------------------- |
| A locked block removed, or swapped for another block type  | `region_locked`               |
| A block inserted between two of a run's blocks             | `region_locked`               |
| A run's blocks reordered or split across slots             | `region_locked`               |
| With `subtree`: any slot inside a locked block changed     | `region_locked`               |
| With content frozen (open question 1): any field changed   | `region_frozen`               |

- The same rules as today: new edits are judged, copies are not. A clone carries its source's
  locks; a version restore keeps the locks held now.
- Coworker's `patchBlocks` is refused with the same issues, so a proposal names the lock it ran
  into instead of failing silently.
- Imports judge regions only on entries that exist and hold locks; a new entry from an import has
  none.

## Surfaces

Both surfaces, as AGENTS.md requires:

- **REST:** `PUT /entries/{id}/block-locks` (the whole list, with `expectedVersion` as other
  entry writes take it), and the locks returned on the management entry read. Delivery and
  preview never return them.
- **MCP:** `entries_block_locks_get` and `entries_block_locks_set`.
- **SDK:** `cma.entries.blockLocks.{get,set}`.
- **Permission:** a content-level action `lock` per content type, alongside `write` and `publish`
  (`ForbiddenError('content:lock:<type>')`). Unlocking takes the same action. (Open question 2.)
- **Audit:** every lock and unlock is an audit event with the keys and depth.

## The canvas

- Select a block (or shift-select neighbours in one slot) → **Lock** in the block's menu, for
  people with `lock`. The menu offers "This block and everything inside" (`subtree`) or "Only
  this block" (`self`).
- A locked region draws a lock on its outline and in Layers, with who locked it and when. Its
  seams, move, duplicate and remove are gone, as for a locked slot; editors without `lock` see
  the same, plus "Locked by …".
- Someone with `lock` sees **Unlock** in the same place.
- The entry form shows the same lock on the blocks' cards.
- The live preview channel needs no change: locks change what the admin offers, not what the
  page renders.

## Open questions

1. **What a lock freezes.** Structure only (as a slot lock: blocks can't be added, removed,
   moved or swapped, but their fields stay editable), or structure and content (fully frozen)?
   Proposed: structure by default, with "and content" as an option on the lock
   (`freeze: 'structure' | 'all'`).
2. **Who can lock and unlock.** A new `lock` content action (proposed), or the admin role only?
   Should unlocking take more than locking (for example, only the person who locked it, or an
   admin)?
3. **Locales.** When a blocks field is localized, does a lock hold in one locale or every locale?
   Proposed: every locale, by `_key`, wherever the keys are present; a locale without those keys
   is not affected.
4. **Stale locks.** When a locked block no longer exists (a schema change removed its block type,
   or a copy dropped it), proposed: show the lock as stale, as the block config shows stale rules,
   and never let it block a save. Stale locks can be cleared by anyone with `lock`.
5. **Versions.** Should locking be recorded in the entry's version history, so a restore can bring
   old locks back? Proposed: no; locks are current state, kept in the audit log.

## Out of scope

- Type-wide subtree locks (option A) and locked patterns (option C).
- Locking non-block fields: field-level permissions already cover who may change a field.
- Locks that expire, or that lift on publish.
