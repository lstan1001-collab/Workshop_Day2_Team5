import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';
import { toSingaporeISO } from '../lib/timezone';
import type { User } from '../lib/db';

let persistence: typeof import('../lib/db');
let user: User;

test.beforeAll(async () => {
  persistence = await import('../lib/db');
  user = persistence.userDB.create(`productivity-e2e-${randomUUID()}`);
});

test.afterAll(() => {
  if (user) persistence.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  persistence?.db.close();
});

test('real APIs connect template creation/use, backup/import and calendar display', async ({ context, page, playwright }) => {
  const secret = process.env.FRONTEND_TEST_SECRET;
  if (!secret) throw new Error('Frontend test session key is missing');
  const token = await new SignJWT({ userId: user.id, username: user.username })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .setIssuer('todo-app').setAudience('todo-app')
    .sign(new TextEncoder().encode(secret));
  await context.addCookies([{ name: 'session', value: token, domain: '127.0.0.1', path: '/' }]);

  const anonymous = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:3217' });
  try {
    expect((await anonymous.get('/api/templates')).status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  const created = await context.request.post('/api/templates', {
    data: {
      name: 'Live checklist template', title_template: 'Live integration todo',
      priority: 'high', due_date_offset_minutes: 1440,
      subtasks: [{ title: 'Live checklist step', position: 0 }],
    },
  });
  expect(created.status()).toBe(201);
  const saved = await created.json();

  await page.goto('/');
  const useResponse = page.waitForResponse(response =>
    response.url().endsWith(`/api/templates/${saved.id}/use`) && response.request().method() === 'POST');
  await page.getByRole('combobox', { name: 'Use Template', exact: true }).selectOption(String(saved.id));
  const used = await useResponse;
  expect(used.status()).toBe(201);
  const todo = await used.json();
  expect(todo.subtasks).toEqual([expect.objectContaining({ title: 'Live checklist step', completed: false })]);
  await expect(page.getByText('Live integration todo', { exact: true })).toHaveCount(1);

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloading;
  const file = await download.path();
  if (!file) throw new Error('Backup download was not saved');
  const backup = await readFile(file);
  const payload = JSON.parse(backup.toString('utf8'));
  expect(payload).toMatchObject({
    version: 1, todos: [{ title: 'Live integration todo', subtasks: [{ title: 'Live checklist step' }] }],
  });
  await page.getByLabel('Import JSON file', { exact: true }).setInputFiles({
    name: 'backup.json', mimeType: 'application/json', buffer: backup,
  });
  await expect(page.getByText('Successfully imported 1 todos', { exact: true })).toBeVisible();
  await expect(page.getByText('Live integration todo', { exact: true })).toHaveCount(2);

  const month = toSingaporeISO(new Date(todo.due_date)).slice(0, 7);
  await page.goto(`/calendar?month=${month}`);
  const day = page.locator('tbody td button').filter({ hasText: 'Live integration todo' });
  await expect(day).toHaveCount(1);
  await expect(day.getByText('Live integration todo', { exact: true })).toHaveCount(2);
  await day.click();
  await expect(page.getByRole('dialog').getByText('Live integration todo', { exact: true })).toHaveCount(2);
});
