import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RunTokens } from '~/cms/components/migrations/RunTokens';
import type { MigrationRunView } from '~/cms/lib/management';

const view = (agentTokens?: MigrationRunView['agentTokens']) =>
  ({
    run: { id: 'run-1' },
    pages: { total: 0, fetched: 0, failed: 0, byStage: {} },
    templates: [
      { id: 't1', label: 'Blog post', status: 'approved' },
      { id: 't2', label: 'Product', status: 'authoring' },
    ],
    ...(agentTokens ? { agentTokens } : {}),
  }) as unknown as MigrationRunView;

const show = (v: MigrationRunView) =>
  render(
    <MemoryRouter>
      <RunTokens view={v} />
    </MemoryRouter>,
  );

describe('a run’s agent tokens', () => {
  it('says what is spent, held and the cap, with no notice while no agent stopped', () => {
    show(view({ cap: 12_000_000, spent: 340_000, reserved: 41_000, stoppedTemplateIds: [] }));
    expect(screen.getByText('12,000,000')).toBeTruthy();
    expect(screen.getByText('340,000')).toBeTruthy();
    expect(screen.getByText('41,000')).toBeTruthy();
    expect(screen.queryByText(/stopped at the cap/)).toBeNull();
  });

  it('names the templates whose agents stopped, each a link to author it', () => {
    show(
      view({ cap: 100_000, spent: 99_000, reserved: 0, stoppedTemplateIds: ['t1', 't2', 'gone'] }),
    );
    expect(screen.getByText('One agent stopped at the cap')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Product' }).getAttribute('href')).toBe(
      '/migrations/run-1/templates/t2',
    );
    expect(screen.queryByRole('link', { name: 'Blog post' })).toBeNull();
  });

  it('shows nothing where the API says nothing', () => {
    show(view());
    expect(screen.queryByText('Agent tokens')).toBeNull();
  });
});
