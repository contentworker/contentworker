import {
  AppOperationFailedError,
  authorize,
  DomainError,
  holdsScope,
  MAX_OPERATION_PAYLOAD_BYTES,
  NotConfiguredError,
  NotFoundError,
  normalizeInstalledPlugin,
  type OperationSchema,
  operationValueIssues,
  type PermissionScope,
  type PluginOperation,
  type Principal,
  type Scope,
  ValidationError,
} from '@contentworker/domain';
import { redactCredentials } from '@contentworker/redaction';
import type { AppContext } from './context';

/**
 * App operations: the named, typed calls installed plugins offer (manifest v2), listed and
 * invoked through one use-case each, so REST, OpenAPI and MCP serve the same thing.
 *
 * Who may call an operation is the scope its manifest declares (`requires`), checked like any
 * route's. What the operation may then do is the plugin's grant narrowed to that caller
 * (`createPluginOperationRunner`). Input is checked against the declared schema before the
 * plugin sees it, and output after, so a plugin can neither be handed nor hand back anything
 * the manifest a human approved did not describe.
 */

/** One operation as callers see it. */
export interface AppOperationView {
  /** The plugin's id: `com.example.seo`. */
  readonly plugin: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly requires: PermissionScope;
  readonly mode: 'sync';
  readonly input: OperationSchema;
  readonly output?: OperationSchema;
}

/**
 * The operations `principal` may invoke in `spaceId`: every enabled plugin's, less those whose
 * `requires` the caller doesn't hold. A plugin awaiting re-approval offers none.
 */
export async function listAppOperations(
  ctx: AppContext,
  principal: Principal,
  spaceId: string,
): Promise<AppOperationView[]> {
  authorizeSpace(principal, spaceId);
  const plugins = (await ctx.store.plugins.list(spaceId)).map(normalizeInstalledPlugin);
  return plugins
    .filter((p) => p.enabled && !p.needsReapproval)
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((p) =>
      (p.manifest.operations ?? [])
        .filter((op) => holdsScope(principal.scopes, op.requires))
        .map((op) => view(p.id, p.manifest.name, p.manifest.version, op)),
    );
}

/**
 * Invokes one operation for `principal` and returns its output. Unknown, disabled and
 * not-permitted operations are told apart only by status: not found for the first two, forbidden
 * for the last (the caller could see it exists from the list only if permitted, so this names
 * nothing new).
 */
export async function invokeAppOperation(
  ctx: AppContext,
  principal: Principal,
  scope: Scope,
  pluginId: string,
  name: string,
  input: unknown,
): Promise<{ output: unknown }> {
  authorizeSpace(principal, scope.spaceId);
  const raw = await ctx.store.plugins.get(scope.spaceId, pluginId);
  const plugin = raw ? normalizeInstalledPlugin(raw) : undefined;
  const operation = plugin?.manifest.operations?.find((op) => op.name === name);
  if (!plugin || !plugin.enabled || plugin.needsReapproval || !operation) {
    throw new NotFoundError('App operation', `${pluginId}/${name}`);
  }
  authorize(principal, operation.requires, scope.spaceId);

  const payload = input ?? {};
  assertSize(payload, 'input');
  const issues = operationValueIssues(operation.input, payload, 'input');
  if (issues.length > 0) throw new ValidationError(issues);

  if (!ctx.appOperations) {
    throw new NotConfiguredError('plugins', 'This deployment does not run plugin code');
  }
  let output: unknown;
  try {
    output = await ctx.appOperations.run(plugin, operation, payload, scope, principal);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    // A plugin's message can carry what it fetched with, a key in a URL among it: redacted
    // before it reaches the caller.
    throw new AppOperationFailedError(
      plugin.id,
      name,
      redactCredentials(err instanceof Error ? err.message : 'error'),
    );
  }
  output = output ?? null;
  if (!fits(output)) {
    throw new AppOperationFailedError(plugin.id, name, 'its output is too large or not JSON');
  }
  if (operation.output) {
    const bad = operationValueIssues(operation.output, output, 'output');
    if (bad.length > 0) {
      throw new AppOperationFailedError(
        plugin.id,
        name,
        `its output does not match the declared schema (${bad[0]?.field}: ${bad[0]?.message})`,
      );
    }
  }
  return { output };
}

function view(
  plugin: string,
  pluginName: string,
  pluginVersion: string,
  op: PluginOperation,
): AppOperationView {
  return {
    plugin,
    pluginName,
    pluginVersion,
    name: op.name,
    title: op.title,
    description: op.description,
    requires: op.requires,
    mode: op.mode ?? 'sync',
    input: op.input,
    ...(op.output ? { output: op.output } : {}),
  };
}

/** Any principal of the space may ask; what it gets is narrowed by each operation's `requires`. */
function authorizeSpace(principal: Principal, spaceId: string): void {
  if (principal.spaceId !== '*' && principal.spaceId !== spaceId) {
    throw new NotFoundError('Space', spaceId);
  }
}

function assertSize(value: unknown, field: string): void {
  if (!fits(value)) {
    throw new ValidationError([
      { field, message: `must be JSON of at most ${MAX_OPERATION_PAYLOAD_BYTES} bytes` },
    ]);
  }
}

function fits(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return (
      text !== undefined && new TextEncoder().encode(text).length <= MAX_OPERATION_PAYLOAD_BYTES
    );
  } catch {
    return false;
  }
}
