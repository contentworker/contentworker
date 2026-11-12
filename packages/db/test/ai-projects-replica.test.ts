import { describe, expect, it } from 'vitest';
import { createD1Store } from '../src/store';
import { testDb } from './env';

/**
 * A read replica behind 0045_ai_projects has no `ai_projects` table: reads of projects answer
 * none rather than fail every AI call. Its own file, as it drops the table from its database.
 */
describe('AI projects on a replica behind 0045', () => {
  it('lists none, and gets no project and no default', async () => {
    await testDb.prepare('DROP TABLE ai_projects').run();
    const store = createD1Store(testDb);
    const scope = { spaceId: 's', environmentId: 'main' };
    expect(await store.aiProjects.list(scope)).toEqual([]);
    expect(await store.aiProjects.get(scope, 'p1')).toBeNull();
    expect(await store.aiProjects.getDefault(scope)).toBeNull();
  });
});
