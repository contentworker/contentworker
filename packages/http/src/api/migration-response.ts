import {
  type ApproveMigrationTemplateResult,
  type MigrationRunView,
  sha256Hex,
  type TryImportScriptResult,
  templateReviewDigest,
} from '@contentworker/application';
import {
  type MigrationArtifact,
  type MigrationPage,
  type MigrationTemplate,
  resolveImportScriptOutput,
} from '@contentworker/domain';

/**
 * How a site migration's records leave the server, on the Management API and MCP alike. An
 * artifact (a page's HTML, a script's output) is named by its hash and size only: its object key
 * is where the bytes live in the bucket, which no client needs, and the bytes themselves never
 * travel inline. Structure fingerprints stay in too: they are clustering's working data, often
 * hundreds of entries a page, and say nothing a reader acts on.
 *
 * A template carries its `reviewDigest`, what an approval names as the version a person read. A
 * script's output leaves resolved (`resolveImportScriptOutput`): its `$html` fragments as
 * `RichTextDocument` trees, never as markup.
 */

export type MigrationArtifactResponse = Omit<MigrationArtifact, 'key'>;

export type MigrationPageResponse = Omit<MigrationPage, 'html' | 'output' | 'fingerprint'> & {
  readonly html: MigrationArtifactResponse | null;
  readonly output: MigrationArtifactResponse | null;
};

export type MigrationTemplateResponse = Omit<MigrationTemplate, 'script' | 'fingerprint'> & {
  readonly script: MigrationArtifactResponse | null;
  /** What `reviewed` names when approving: SHA-256 of the proposal and the script version. */
  readonly reviewDigest: string;
};

const artifact = (a: MigrationArtifact | null): MigrationArtifactResponse | null =>
  a ? { sha256: a.sha256, bytes: a.bytes } : null;

export function migrationPageResponse(page: MigrationPage): MigrationPageResponse {
  const { html, output, fingerprint: _fingerprint, ...rest } = page;
  return { ...rest, html: artifact(html), output: artifact(output) };
}

export function migrationTemplateResponse(template: MigrationTemplate): MigrationTemplateResponse {
  const { script, fingerprint: _fingerprint, ...rest } = template;
  return { ...rest, script: artifact(script), reviewDigest: templateReviewDigest(template) };
}

/** A try's results, each output resolved: no `$html` fragment leaves the server. */
export function migrationTryResponse(result: TryImportScriptResult) {
  return {
    summary: result.summary,
    results: result.results.map(({ output, ...rest }) => ({
      ...rest,
      ...(output ? { output: resolveImportScriptOutput(output) } : {}),
    })),
  };
}

export function migrationApprovalResponse(result: ApproveMigrationTemplateResult) {
  return {
    template: migrationTemplateResponse(result.template),
    signalled: result.signalled,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

/** A template's script as text, with its hash (both null before one is written). */
export function migrationScriptResponse(script: string | null) {
  return { script, sha256: script === null ? null : sha256Hex(script) };
}

export function migrationRunViewResponse(view: MigrationRunView) {
  return {
    run: view.run,
    pages: view.pages,
    templates: view.templates.map(migrationTemplateResponse),
  };
}
