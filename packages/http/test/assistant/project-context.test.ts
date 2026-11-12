import { ASSISTANT_TOOLS } from '@contentworker/domain';
import { describe, expect, it } from 'vitest';
import { readContext } from '../../src/assistant/context';

/** The conversation's AI project, as the panel sends it with each turn. */
describe('Coworker’s AI project', () => {
  const scope = { spaceId: 'shop', environmentId: 'main' };

  it('reads an id, or null for none; anything else is the default', () => {
    expect(readContext({ scope, projectId: 'p-1' })?.projectId).toBe('p-1');
    expect(readContext({ scope, projectId: null })).toMatchObject({ projectId: null });
    expect(readContext({ scope })).not.toHaveProperty('projectId');
    // Not an id the admin would send: ignored, so the turn takes the default.
    expect(readContext({ scope, projectId: '../x y' })).not.toHaveProperty('projectId');
    expect(readContext({ scope, projectId: 7 })).not.toHaveProperty('projectId');
  });

  it('offers the project reads and nothing that changes a project', () => {
    for (const name of ['ai_projects_list', 'ai_project_get', 'ai_project_reference_read']) {
      expect(ASSISTANT_TOOLS[name as keyof typeof ASSISTANT_TOOLS]).toMatchObject({
        write: false,
        confirm: false,
      });
    }
    for (const name of [
      'ai_project_create',
      'ai_project_update',
      'ai_project_delete',
      'ai_project_default_set',
      'ai_project_reference_extract',
    ]) {
      expect(Object.hasOwn(ASSISTANT_TOOLS, name)).toBe(false);
    }
  });
});
