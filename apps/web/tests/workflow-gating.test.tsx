// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { gatingLabel } from '~/cms/routes/Workflows';

describe('the workflow list’s publishing label', () => {
  it('says what publishing checks (the published version) and what the draft would change', () => {
    expect(gatingLabel({ publishGated: true, gatesPublish: true })).toBe(
      'Gated: entries publish only through this workflow',
    );
    expect(gatingLabel({ publishGated: true, gatesPublish: false })).toBe(
      'Gated (the draft turns it off; publish to apply)',
    );
    expect(gatingLabel({ publishGated: false, gatesPublish: true })).toBe(
      'Not gated (the draft gates; not in force until published)',
    );
    expect(gatingLabel({ publishGated: false, gatesPublish: false })).toBe('Not gated');
  });
});
