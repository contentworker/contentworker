import type { MigrationRunView } from '@contentworker/application';
import type { MigrationArtifact, MigrationPage, MigrationTemplate } from '@contentworker/domain';

/**
 * How a site migration's records leave the server, on the Management API and MCP alike. An
 * artifact (a page's HTML, a script's output) is named by its hash and size only: its object key
 * is where the bytes live in the bucket, which no client needs, and the bytes themselves never
 * travel inline. Structure fingerprints stay in too: they are clustering's working data, often
 * hundreds of entries a page, and say nothing a reader acts on.
 */

export type MigrationArtifactResponse = Omit<MigrationArtifact, 'key'>;

export type MigrationPageResponse = Omit<MigrationPage, 'html' | 'output' | 'fingerprint'> & {
  readonly html: MigrationArtifactResponse | null;
  readonly output: MigrationArtifactResponse | null;
};

export type MigrationTemplateResponse = Omit<MigrationTemplate, 'script' | 'fingerprint'> & {
  readonly script: MigrationArtifactResponse | null;
};

const artifact = (a: MigrationArtifact | null): MigrationArtifactResponse | null =>
  a ? { sha256: a.sha256, bytes: a.bytes } : null;

export function migrationPageResponse(page: MigrationPage): MigrationPageResponse {
  const { html, output, fingerprint: _fingerprint, ...rest } = page;
  return { ...rest, html: artifact(html), output: artifact(output) };
}

export function migrationTemplateResponse(template: MigrationTemplate): MigrationTemplateResponse {
  const { script, fingerprint: _fingerprint, ...rest } = template;
  return { ...rest, script: artifact(script) };
}

export function migrationRunViewResponse(view: MigrationRunView) {
  return {
    run: view.run,
    pages: view.pages,
    templates: view.templates.map(migrationTemplateResponse),
  };
}
