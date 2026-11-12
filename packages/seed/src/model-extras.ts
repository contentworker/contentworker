import { createContentType, SYSTEM_CALLER } from '@contentworker/application';
import type { ContentTypeDraft, FieldDefinition } from '@contentworker/domain';
import { contentTypeExists, ensureContentType } from './helpers';
import type { SeedRun } from './types';

const title: FieldDefinition = {
  apiId: 'title',
  name: 'Title',
  type: 'Symbol',
  localized: true,
  required: true,
  position: 0,
};

const body: FieldDefinition = {
  apiId: 'body',
  name: 'Body',
  type: 'Text',
  localized: true,
  required: false,
  position: 1,
};

const type = (
  apiId: string,
  name: string,
  rest: Partial<ContentTypeDraft> = {},
): ContentTypeDraft => ({ apiId, name, displayField: 'title', fields: [title, body], ...rest });

/**
 * Types beside the demo model that exist to show the admin's content nav and overview in every
 * state, in local dev only (the sample starter installs the eight above and nothing else): two
 * groups beside the ungrouped types, a singleton, a name too long for the nav, a name that
 * suggests no icon (drawn as a blank page), icons left to the name and one picked by hand, and a
 * type not yet published. They hold no entries.
 */
const PUBLISHED: readonly ContentTypeDraft[] = [
  type('pressRelease', 'Press release', { group: 'Newsroom' }),
  type('mediaContact', 'Media contact', { group: 'Newsroom' }),
  type('investorBriefing', 'Quarterly investor relations briefing', {
    group: 'Newsroom',
    icon: 'briefcase',
  }),
  type('siteSettings', 'Site settings', { group: 'Site', singleton: true }),
  type('navigationMenu', 'Navigation menu', { group: 'Site' }),
  type('widget', 'Widget', {
    description: 'A name that suggests no icon: the nav draws a blank page.',
  }),
];

/** Left as a draft, so the nav shows a type that isn't published yet. */
const DRAFT: ContentTypeDraft = type('testimonial', 'Testimonial', {
  group: 'Site',
  description: 'Not published yet: the nav marks it, and no entries can be written.',
});

export async function seedModelExtras(run: SeedRun): Promise<void> {
  for (const draft of PUBLISHED) await ensureContentType(run, draft);
  if (!(await contentTypeExists(run, DRAFT.apiId))) {
    await createContentType(run.ctx, SYSTEM_CALLER, run.scope, DRAFT);
  }
}
