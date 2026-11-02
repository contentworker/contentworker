// "Draft with AI" for workflows: while the copilot works, the Draft button shows the workflow icon
// composing itself (the AI loader) and the dialog announces it, and the proposal comes back for
// review before anything is applied.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

let resolveCopilot: (value: unknown) => void = () => {};
const client = {
  workflowCopilot: vi.fn(
    () =>
      new Promise((resolve) => {
        resolveCopilot = resolve;
      }),
  ),
};
vi.mock('~/cms/lib/client-context', () => ({
  useClient: () => ({ client }),
}));

const { CopilotDialog } = await import('~/cms/components/workflow/CopilotDialog');

afterEach(cleanup);

describe('workflow copilot', () => {
  it('composes the workflow icon on the Draft button while the copilot drafts', async () => {
    render(<CopilotDialog open onOpenChange={() => {}} onProposal={() => {}} />);
    fireEvent.change(screen.getByLabelText('What should happen'), {
      target: { value: 'Ask an editor to approve, then publish' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));

    const button = await screen.findByRole('button', { name: 'Drafting…' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.querySelector('svg.cw-compose')).toBeTruthy();
    expect(screen.getByText('Drafting the workflow.')).toBeTruthy();

    resolveCopilot({ graph: { nodes: [], edges: [] }, summary: '' });
    await waitFor(() => expect(client.workflowCopilot).toHaveBeenCalledOnce());
  });
});
