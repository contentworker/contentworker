import { DomainError } from '../errors';

/**
 * A workflow that gates publishing, as its latest published version has it: entries of the
 * content types it covers publish only from one of its runs. Only published versions run, so a
 * draft's gating means nothing until it is published, and publishing a version with gating off
 * is how an admin lets entries publish directly again.
 */
export interface PublishGate {
  readonly workflowId: string;
  /** The workflow's current name, for the refusal message. */
  readonly name: string;
  /** The published version the gate comes from. */
  readonly version: number;
  /** Content type api ids the workflow covers; empty means every type. */
  readonly contentTypes: readonly string[];
}

/** The gates covering an entry of `contentTypeApiId` (several workflows may cover one entry). */
export function gatesCovering(
  gates: readonly PublishGate[],
  contentTypeApiId: string,
): PublishGate[] {
  return gates.filter(
    (g) => g.contentTypes.length === 0 || g.contentTypes.includes(contentTypeApiId),
  );
}

/** One entry a publish refused, and the workflows any of whose runs may publish it. */
export interface GatedEntry {
  readonly entryId: string;
  readonly workflows: readonly { readonly id: string; readonly name: string }[];
}

const quoted = (workflows: GatedEntry['workflows']) =>
  workflows.map((w) => `"${w.name}"`).join(' or ');

/**
 * A publish of an entry a gated workflow covers, made outside a run of that workflow (HTTP 409,
 * `publish_gated`). There is no override: an admin who needs to publish directly turns gating off
 * on the workflow and publishes that version.
 */
export class PublishGatedError extends DomainError {
  readonly entries: readonly GatedEntry[];
  constructor(entries: readonly GatedEntry[], context?: { readonly releaseId: string }) {
    const [first] = entries;
    const message =
      context || entries.length !== 1 || !first
        ? `${context ? `Release "${context.releaseId}" holds` : 'These are'} ${entries.length} ${
            entries.length === 1 ? 'entry' : 'entries'
          } that publish only through a workflow: ${entries
            .map((e) => `"${e.entryId}" (${quoted(e.workflows)})`)
            .join(
              ', ',
            )}. Publish them through a run of the workflow, or turn off its publish gating.`
        : `Entry "${first.entryId}" publishes only through a run of the workflow ${quoted(
            first.workflows,
          )}. Start a run of it, or turn off its publish gating.`;
    super('publish_gated', message, { entries, ...context });
    this.entries = entries;
  }
}
