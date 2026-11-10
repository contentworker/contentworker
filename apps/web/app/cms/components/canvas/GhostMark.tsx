/**
 * Coworker's ghost block, as the admin marks it over the customer's page (the canvas, and the Site
 * frame beside the form): a dashed `ai` edge around the block the page drew from the proposal, and
 * its label in words at the top corner ("Proposed", "Proposed change", "Proposed removal") with the
 * mark, on a paper chip so it holds against whatever the page is drawn in. Never colour alone.
 * Decorative where it is drawn (the overlay is hidden from assistive technology); Layers and the
 * card say the same in words.
 */
import type { LiveRect } from '@contentworker/sdk-core/live-preview';
import { type GhostKind, ghostLabel } from '~/cms/lib/live-preview/proposals';
import { Mark } from '~/components/mark';

export function GhostChip({ kind }: { kind: GhostKind }) {
  return (
    <span className="absolute -top-2.5 left-1.5 inline-flex items-center gap-1 rounded-full border border-ai/40 bg-background px-1.5 py-0.5 font-medium text-2xs text-ai leading-none shadow-sm">
      <Mark className="size-3 shrink-0" />
      {ghostLabel(kind)}
    </span>
  );
}

export function GhostMark({ rect, kind }: { rect: LiveRect; kind: GhostKind }) {
  return (
    <div
      data-ghost-outline={kind}
      className="absolute rounded-sm border border-ai border-dashed"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <GhostChip kind={kind} />
    </div>
  );
}
