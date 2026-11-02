import { type AppContext, auditActor, recordAudit } from '@contentworker/application';
import type { Principal } from '@contentworker/domain';

/**
 * The MCP half of the audit trail. REST's `auditMiddleware` records every successful mutating
 * request; a tool call is the same capability reached another way, so a tool that changed
 * something records the same row: who, what, which space and environment, which target. The
 * action is `MCP <tool>` where REST's is `<METHOD> <route>`.
 *
 * Reads never write here (one writer per database: no per-request writes on read paths). A tool
 * is a read when it declares so itself, with the MCP annotation `readOnlyHint: true` beside its
 * schema; anything else is a write, so a new tool is audited until someone decides otherwise.
 */
export function declaresReadOnly(config: unknown): boolean {
  return (
    (config as { annotations?: { readOnlyHint?: unknown } } | undefined)?.annotations
      ?.readOnlyHint === true
  );
}

type Args = Record<string, unknown>;

/** Tools that write only when asked to; otherwise they return a proposal or a report. */
export const WRITES_WHEN: Readonly<Record<string, (args: Args) => boolean>> = {
  entry_translate: (a) => a.apply === true,
  entry_summarize: (a) => a.apply === true,
  entry_autofill_field: (a) => a.apply === true,
  entry_suggest_tags: (a) => a.apply === true,
  entry_audit: (a) => a.createTasks === true,
  ai_action_run: (a) => a.apply === true,
  asset_generate_alt_text: (a) => a.apply === true,
  asset_auto_tag: (a) => a.apply === true,
  environment_import: (a) => a.dryRun !== true,
  environment_clone: (a) => a.dryRun !== true,
};

/**
 * Whether a call to `tool` with `args` changes anything, and so belongs in the audit trail.
 * `readOnly` is the tool's own `readOnlyHint` (`declaresReadOnly`).
 */
export function toolMutates(tool: string, args: Args, readOnly: boolean): boolean {
  if (readOnly) return false;
  return WRITES_WHEN[tool]?.(args) ?? true;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Which of a tool's arguments its input schema declares (a Zod object's shape). */
export function declaredArgs(inputSchema: unknown): ReadonlySet<string> {
  const shape = (inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
  return new Set(shape ? Object.keys(shape) : []);
}

export interface ToolAuditInput {
  readonly tool: string;
  /** The arguments after environment resolution: an alias already names its target. */
  readonly args: Args;
  /** The arguments the tool's schema declares, to tell a defaulted scope from no scope. */
  readonly declared: ReadonlySet<string>;
  /** The tool declares `readOnlyHint: true`: a read, never audited. */
  readonly readOnly: boolean;
  readonly principal: Principal;
  readonly defaultSpace: string;
  readonly defaultEnvironment: string;
}

/**
 * Records one successful mutating tool call. The space and environment are the ones the tool
 * acted in (the server's defaults when the call left them out, as `scopeOf` does); a tool with
 * no space (none declared, no `spaceId` named) has nowhere to file a row and records none. Like
 * REST's, a failed audit write never fails the call.
 */
export async function auditToolCall(ctx: AppContext, input: ToolAuditInput): Promise<void> {
  const { tool, args, declared } = input;
  if (!toolMutates(tool, args, input.readOnly)) return;
  const spaceId = declared.has('space')
    ? (str(args.space) ?? input.defaultSpace)
    : str(args.spaceId);
  if (!spaceId) return;
  try {
    await recordAudit(ctx, {
      spaceId,
      environmentId: declared.has('environment')
        ? (str(args.environment) ?? input.defaultEnvironment)
        : undefined,
      actor: auditActor(input.principal),
      action: `MCP ${tool}`,
      targetId: str(args.id) ?? str(args.apiId) ?? str(args.alias),
      status: 200,
    });
  } catch {
    /* auditing must never break the tool call */
  }
}
