import { isAgentJob, isDomainEvent } from '@contentworker/platform/messages';
import { describe, expect, it } from 'vitest';

const scope = { spaceId: 'space-1', environmentId: 'main' };

describe('isDomainEvent', () => {
  it('accepts a well-formed queued event', () => {
    expect(
      isDomainEvent({
        id: 'evt-1',
        type: 'entry.published',
        occurredAt: '2026-01-01T00:00:00.000Z',
        scope,
        entryId: 'entry-1',
      }),
    ).toBe(true);
  });

  it('rejects non-objects and null', () => {
    expect(isDomainEvent(null)).toBe(false);
    expect(isDomainEvent('entry.published')).toBe(false);
    expect(isDomainEvent(42)).toBe(false);
  });

  it('rejects events missing required fields or scope parts', () => {
    const base = {
      id: 'evt-1',
      type: 'entry.published',
      occurredAt: '2026-01-01T00:00:00.000Z',
      scope,
    };
    expect(isDomainEvent({ ...base, id: undefined })).toBe(false);
    expect(isDomainEvent({ ...base, occurredAt: 12345 })).toBe(false);
    expect(isDomainEvent({ ...base, scope: undefined })).toBe(false);
    expect(isDomainEvent({ ...base, scope: { spaceId: 'space-1' } })).toBe(false);
  });
});

describe('isAgentJob', () => {
  it('accepts a well-formed agent job', () => {
    expect(isAgentJob({ kind: 'agent.publish_run', scope, entryId: 'entry-1' })).toBe(true);
  });

  it('rejects other kinds and malformed jobs', () => {
    expect(isAgentJob(null)).toBe(false);
    expect(isAgentJob({ kind: 'agent.other_run', scope, entryId: 'entry-1' })).toBe(false);
    expect(isAgentJob({ kind: 'agent.publish_run', scope })).toBe(false);
    expect(isAgentJob({ kind: 'agent.publish_run', entryId: 'entry-1' })).toBe(false);
    // A DomainEvent is not an agent job — the contentworker-agents consumer must not
    // accept messages meant for contentworker-events.
    expect(
      isAgentJob({
        id: 'evt-1',
        type: 'entry.published',
        occurredAt: '2026-01-01T00:00:00.000Z',
        scope,
      }),
    ).toBe(false);
  });
});
