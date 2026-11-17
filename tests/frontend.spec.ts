import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';
import type { Todo } from '../lib/db';

const initial: Todo = {
  id: 1, user_id: 1, title: 'Weekly review', completed: false,
  due_date: '2099-01-31T09:00:00+08:00', priority: 'high',
  is_recurring: true, recurrence_pattern: 'monthly', reminder_minutes: 60,
  last_notification_sent: null, created_at: '2026-11-17T10:00:00+08:00',
  updated_at: null, subtasks: [], tags: [],
};

test.beforeEach(async ({ context }) => {
  const secret = process.env.FRONTEND_TEST_SECRET;
  if (!secret) throw new Error('Frontend test session key is missing');
  const token = await new SignJWT({ userId: 1, username: 'frontend-test' })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .setIssuer('todo-app').setAudience('todo-app')
    .sign(new TextEncoder().encode(secret));
  await context.addCookies([{ name: 'session', value: token, domain: '127.0.0.1', path: '/' }]);
});

test('recurring completion reconciles next instance and rolls back an API failure', async ({ page }) => {
  let fail = true;
  let updates = 0;
  await page.route('**/api/todos', route => route.fulfill({ json: [initial] }));
  await page.route('**/api/todos/1', async route => {
    updates++;
    if (fail) await route.fulfill({ status: 500, json: { error: 'Completion unavailable' } });
    else await route.fulfill({ json: {
      todo: { ...initial, completed: true },
      nextInstance: { ...initial, id: 2, due_date: '2099-02-28T09:00:00+08:00' },
    } });
  });
  await page.goto('/');
  await expect(page.getByText('Repeat: monthly')).toBeVisible();
  const checkbox = page.getByRole('checkbox', { name: 'Mark "Weekly review" as complete', exact: true });
  await checkbox.click();
  await expect(page.getByText('Completion unavailable')).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  fail = false;
  await checkbox.click();
  await expect(page.getByRole('heading', { name: 'Completed (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pending (1)' })).toBeVisible();
  await expect(page.getByText('Weekly review', { exact: true })).toHaveCount(2);
  expect(updates).toBe(2);
});

test('due-date gating, Singapore serialization and pending submission protection', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/todos', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] });
    writes++;
    const body = route.request().postDataJSON();
    expect(body.due_date).toBe('2099-01-31T09:00+08:00');
    expect(body.reminder_minutes).toBe(60);
    expect(body.recurrence_pattern).toBe('monthly');
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ status: 201, json: { ...initial, title: body.title } });
  });
  await page.goto('/');
  await expect(page.getByLabel('Repeat', { exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Reminder', exact: true })).toBeDisabled();
  await page.getByLabel('Title', { exact: true }).fill('Monthly plan');
  await page.getByLabel('Due date (Singapore)').fill('2099-01-31T09:00');
  await page.getByLabel('Repeat', { exact: true }).check();
  await page.getByRole('combobox', { name: 'Recurrence pattern' }).selectOption('monthly');
  await page.getByRole('combobox', { name: 'Reminder', exact: true }).selectOption('60');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  await expect(page.getByText('Monthly plan', { exact: true })).toBeVisible();
  expect(writes).toBe(1);
});

test('subtask progress stays independent and edit Escape makes no request', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/todos', route => route.fulfill({ json: [initial] }));
  await page.route('**/api/todos/1', route => {
    requests++;
    return route.fulfill({ json: initial });
  });
  await page.route('**/api/todos/1/subtasks', route => route.fulfill({
    status: 201,
    json: { id: 5, todo_id: 1, title: 'Read notes', completed: false, position: 0, created_at: initial.created_at },
  }));
  await page.route('**/api/subtasks/5', route => route.fulfill({
    json: { id: 5, todo_id: 1, title: 'Read notes', completed: true, position: 0, created_at: initial.created_at },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Show Subtasks' }).click();
  await page.getByLabel('New subtask').fill('Read notes');
  await page.getByLabel('New subtask').press('Enter');
  await expect(page.getByText('0/1 subtasks (0%)')).toBeVisible();
  await page.getByRole('checkbox', { name: 'Read notes', exact: true }).check();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(page.getByRole('checkbox', { name: 'Mark "Weekly review" as complete', exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Hide Subtasks' }).click();
  await expect(page.getByText('1/1 subtasks (100%)')).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Title', { exact: true }).fill('Discard me');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Weekly review', { exact: true })).toBeVisible();
  expect(requests).toBe(0);
});

test('notification acknowledgement retries without displaying the same reminder twice in one tab', async ({ page }) => {
  let stamps = 0;
  await page.clock.install();
  await page.addInitScript(() => {
    let displayed = 0;
    class TestNotification {
      static permission = 'granted';
      static async requestPermission() { return 'granted'; }
      constructor() {
        displayed++;
        Object.defineProperty(window, 'displayedReminders', { value: displayed, configurable: true });
      }
    }
    Object.defineProperty(window, 'Notification', { value: TestNotification, configurable: true });
  });
  await page.route('**/api/todos', route => route.fulfill({ json: [initial] }));
  await page.route('**/api/notifications/check', route => route.fulfill({ json: { success: true, data: [initial] } }));
  await page.route('**/api/todos/1', route => {
    stamps++;
    return route.fulfill(stamps === 1
      ? { status: 500, json: { error: 'Stamp unavailable' } }
      : { json: initial });
  });
  await page.goto('/');
  await expect(page.getByText('Stamp unavailable')).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect.poll(() => stamps).toBe(2);
  expect(await page.evaluate(() => Reflect.get(window, 'displayedReminders'))).toBe(1);
});

test('clearing a due date removes recurrence and reminders from the saved edit', async ({ page }) => {
  let updates = 0;
  await page.route('**/api/todos', route => route.fulfill({ json: [initial] }));
  await page.route('**/api/todos/1', route => {
    updates++;
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({
      due_date: null, is_recurring: false, recurrence_pattern: null, reminder_minutes: null,
    });
    return route.fulfill({ json: { ...initial, ...body } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Due date (Singapore)').fill('');
  await expect(dialog.getByLabel('Repeat', { exact: true })).not.toBeChecked();
  await expect(dialog.getByLabel('Repeat', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'Reminder', exact: true })).toHaveValue('');
  await expect(dialog.getByRole('combobox', { name: 'Reminder', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Repeat: monthly')).toHaveCount(0);
  await expect(page.getByText('Reminder: 1h')).toHaveCount(0);
  expect(updates).toBe(1);
});

test('failed subtask mutations restore checklist progress and deleting the last child hides it', async ({ page }) => {
  const child = {
    id: 5, todo_id: 1, title: 'Read notes', completed: false,
    position: 0, created_at: initial.created_at,
  };
  let failDelete = true;
  const methods: string[] = [];
  await page.route('**/api/todos', route => route.fulfill({ json: [{ ...initial, subtasks: [child] }] }));
  await page.route('**/api/subtasks/5', route => {
    const method = route.request().method();
    methods.push(method);
    if (method === 'PUT') return route.fulfill({ status: 500, json: { error: 'Checklist update unavailable' } });
    if (failDelete) return route.fulfill({ status: 500, json: { error: 'Checklist delete unavailable' } });
    return route.fulfill({ json: { success: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Show Subtasks' }).click();
  const checkbox = page.getByRole('checkbox', { name: 'Read notes', exact: true });
  await checkbox.check();
  await expect(page.getByText('Checklist update unavailable')).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: 'Delete subtask Read notes' }).click();
  await expect(page.getByText('Checklist delete unavailable')).toBeVisible();
  await expect(checkbox).toBeVisible();
  await expect(page.getByText('0/1 subtasks (0%)')).toBeVisible();
  failDelete = false;
  await page.getByRole('button', { name: 'Delete subtask Read notes' }).click();
  await expect(checkbox).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Mark "Weekly review" as complete', exact: true })).not.toBeChecked();
  expect(methods).toEqual(['PUT', 'DELETE', 'DELETE']);
});

test('notification permission is explicit and revocation stops polling', async ({ page }) => {
  let checks = 0;
  await page.clock.install();
  await page.addInitScript(() => {
    class TestNotification {
      static permission: NotificationPermission = 'default';
      static async requestPermission() {
        TestNotification.permission = 'granted';
        return TestNotification.permission;
      }
    }
    Object.defineProperty(window, 'Notification', { value: TestNotification, configurable: true });
  });
  await page.route('**/api/todos', route => route.fulfill({ json: [] }));
  await page.route('**/api/notifications/check', route => {
    checks++;
    return route.fulfill({ json: { success: true, data: [] } });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Enable Notifications' })).toBeEnabled();
  await page.clock.fastForward(60_000);
  expect(checks).toBe(0);
  await page.getByRole('button', { name: 'Enable Notifications' }).click();
  await expect(page.getByRole('button', { name: 'Notifications On' })).toBeDisabled();
  await expect.poll(() => checks).toBe(1);
  await page.clock.fastForward(30_000);
  await expect.poll(() => checks).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(Notification, 'permission', { value: 'denied', configurable: true });
    window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByRole('button', { name: 'Notifications blocked' })).toBeDisabled();
  await page.clock.fastForward(90_000);
  expect(checks).toBe(2);
});

test('denied notification permission does not poll or change reminder settings', async ({ page }) => {
  let checks = 0;
  let writes = 0;
  await page.clock.install();
  await page.addInitScript(() => {
    class TestNotification {
      static permission = 'denied';
    }
    Object.defineProperty(window, 'Notification', { value: TestNotification, configurable: true });
  });
  await page.route('**/api/todos', route => route.fulfill({ json: [initial] }));
  await page.route('**/api/notifications/check', route => {
    checks++;
    return route.fulfill({ json: { success: true, data: [] } });
  });
  await page.route('**/api/todos/1', route => {
    writes++;
    return route.fulfill({ json: initial });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Notifications blocked' })).toBeDisabled();
  await expect(page.getByText("Allow notifications in this site's browser settings to enable reminders.")).toBeVisible();
  await expect(page.getByText('Reminder: 1h')).toBeVisible();
  await page.clock.fastForward(90_000);
  expect(checks).toBe(0);
  expect(writes).toBe(0);
});
