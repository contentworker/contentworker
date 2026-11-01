import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { api, MGMT, openCms, seedCms, useCmsScope } from './cms';
import { settle } from './settle';

/*
 * The workflow list and editor end to end: create from a template, edit, publish; then an axe
 * sweep of the editor page (the canvas, the palette and the inspector) and its keyboard wiring.
 * The editor edits from lg up; below it is review-only, so these run on the wide projects.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.beforeAll(async ({ request }) => {
  await seedCms(request);
});

test.beforeEach(async ({ page }, info) => {
  test.skip(
    info.project.name.startsWith('iphone') || info.project.name === 'ipad',
    'the workflow editor is review-only below lg',
  );
  await useCmsScope(page);
});

test('creates a workflow from a template, edits it and publishes it', async ({ page }) => {
  await openCms(page, '/workflows');
  await page.getByRole('button', { name: 'New workflow' }).click();
  const sheet = page.getByRole('dialog', { name: 'New workflow' });
  const name = `Review ${Date.now()}`;
  await sheet.getByRole('textbox', { name: 'Name' }).fill(name);
  await sheet.getByRole('combobox', { name: 'Template' }).selectOption('tpl-editorial-review');
  await sheet.getByRole('button', { name: 'Create workflow' }).click();

  const title = page.getByRole('textbox', { name: 'Workflow name' });
  await expect(title).toHaveValue(name, { timeout: 15_000 });
  await expect(page.getByText(/^Not published/)).toBeVisible();
  await expect(page.getByText('Ready to publish')).toBeVisible();

  await title.fill(`${name} (edited)`);
  await expect(page.getByText('Unsaved')).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  await expect(page.getByText('Unsaved')).toBeHidden();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: /as v1\?/ });
  await confirm.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Published v1' })).toBeVisible();
  await expect(page.getByText(/Published v1 · up to date/)).toBeVisible();

  await page.getByRole('link', { name: 'Workflows', exact: true }).first().click();
  const item = page.getByRole('listitem').filter({ hasText: `${name} (edited)` });
  await expect(item.getByText('Published v1')).toBeVisible();
});

test('refuses to publish a draft with errors and lists them', async ({ page, request }) => {
  const res = await api(request, 'POST', `${MGMT}/workflows`, {
    name: `Broken ${Date.now()}`,
    graph: {
      nodes: [
        {
          id: 'c',
          type: 'content.comment',
          label: 'Orphan comment',
          config: { body: 'Hi' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { workflow } = (await res.json()) as { workflow: { id: string } };
  await openCms(page, `/workflows/${workflow.id}`);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Can’t publish yet' });
  await expect(alert).toBeVisible();
  await expect(alert.getByText(/needs exactly one trigger/)).toBeVisible();
});

test('the workflow editor has no accessibility violations', async ({ page, request }, info) => {
  const res = await api(request, 'POST', `${MGMT}/workflows`, {
    name: `A11y ${Date.now()}`,
    graph: { nodes: [], edges: [] },
  });
  const { workflow } = (await res.json()) as { workflow: { id: string } };
  await openCms(page, `/workflows/${workflow.id}`);
  await expect(page.getByRole('navigation', { name: 'Steps' })).toBeVisible({ timeout: 15_000 });

  // Build from the keyboard: the palette adds a trigger, then a step wired in after it.
  await page.getByRole('button', { name: 'Add Submit for review' }).click();
  await page.getByRole('button', { name: 'Add Comment' }).click();
  await expect(page.getByRole('heading', { name: 'Comment' })).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  for (const state of ['step selected', 'nothing selected'] as const) {
    if (state === 'nothing selected') await page.keyboard.press('Escape');
    await settle(page);
    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    if (results.violations.length) {
      await info.attach(`axe-${state}.json`, {
        body: JSON.stringify(results.violations, null, 2),
        contentType: 'application/json',
      });
    }
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
      ),
      `${state}`,
    ).toEqual([]);
  }
});
