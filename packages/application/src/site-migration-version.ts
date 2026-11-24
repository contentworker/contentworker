import {
  MigrationApprovalChangedError,
  type MigrationPage,
  type MigrationTemplate,
} from '@contentworker/domain';
import { sha256Hex } from './token-crypto';

/**
 * Which version of a template a page's output came from. A template's version is what a person
 * approves, its model and its script together, so a page is out of date when either changed.
 */

/**
 * What a person approves: the proposal and the script version, as one SHA-256. A try's summary
 * or a status change doesn't change it; a new proposal or script does.
 */
export function templateReviewDigest(template: MigrationTemplate): string {
  return sha256Hex(
    JSON.stringify({ proposal: template.proposal, script: template.script?.sha256 ?? null }),
  );
}

/**
 * The `outputScript` values that mean "of the template as it stands": the review digest, which a
 * transform writes, and the script's own hash, which transforms wrote before a template could be
 * reopened. Reopening stamps the pages that hold the bare hash with the digest it withdraws
 * (`stampOutputs`), so after one a bare hash never names an earlier model.
 */
export function outputVersions(template: MigrationTemplate): string[] {
  const digest = templateReviewDigest(template);
  return template.script ? [digest, template.script.sha256] : [digest];
}

/** Whether a page's output (or its failed transform) is of one of `versions`. */
export const isOutputOf = (page: MigrationPage, versions: readonly string[]): boolean =>
  page.outputScript !== null && versions.includes(page.outputScript);

/**
 * Refuses a template that is no longer approved as it was when a step began: reopened, or
 * approved again since. An approved template's record changes only by being reopened, so its
 * `version` names the approval.
 */
export function assertSameApproval(template: MigrationTemplate, approval: number): void {
  if (template.status !== 'approved' || template.version !== approval) {
    throw new MigrationApprovalChangedError();
  }
}
