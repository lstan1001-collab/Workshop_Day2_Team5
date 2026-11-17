import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';
import type { Tag, Template, Todo } from '../lib/db';

const initial: Todo = {
  id: 1, user_id: 1, title: 'Weekly review', completed: false,
  due_date: '2099-01-31T09:00:00+08:00', priority: 'high',
  is_recurring: true, recurrence_pattern: 'monthly', reminder_minutes: 60,
  last_notification_sent: null, created_at: '2026-11-17T10:00:00+08:00',
  updated_at: null, subtasks: [], tags: [],
};
const workTag: Tag = {
  id: 6, user_id: 1, name: 'Work', color: '#16A34A',
  created_at: initial.created_at,
};

test.beforeEach(async ({ context }) => {
  const secret = process.env.FRONTEND_TEST_SECRET;
  if (!secret) throw new Error('Frontend test session key is missing');
  const token = await new SignJWT({ userId: 1, username: 'frontend-test' })
    .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .setIssuer('todo-app').setAudience('todo-app')
    .sign(new TextEncoder().encode(secret));
  await context.addCookies([{ name: 'session', value: token, domain: '127.0.0.1', path: '/' }]);
  await context.route('**/api/tags', route => route.fulfill({ json: [] }));
  await context.route('**/api/templates', route => route.fulfill({ json: [] }));
});

test('adds a passkey without disrupting the todo page', async ({ page }) => {
  await page.route('**/api/todos', route => route.fulfill({ json: [initial] }));
  await page.route('**/api/auth/add-passkey-options', route => route.fulfill({ json: {
    challenge: 'dGVzdC1yZWdpc3RyYXRpb24tY2hhbGxlbmdl',
    rp: { id: 'localhost', name: 'Todo App' },
    user: { id: 'MQ', name: 'frontend-test', displayName: 'frontend-test' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    timeout: 60000,
    attestation: 'none',
  } }));
  let submissions = 0;
  await page.route('**/api/auth/add-passkey-verify', route => {
    submissions++;
    expect(route.request().postDataJSON().response.type).toBe('public-key');
    return route.fulfill({ json: { success: true } });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const session = (await page.context().cookies()).find(cookie => cookie.name === 'session');
  if (!session) throw new Error('Frontend test session is missing');
  await page.context().addCookies([{ name: 'session', value: session.value, domain: 'localhost', path: '/' }]);
  await page.goto('http://localhost:3217/');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByText('Passkey added.')).toBeVisible();
  await expect(page.getByText('Weekly review', { exact: true })).toBeVisible();
  expect(submissions).toBe(1);
});

test('templates capture checklist/settings, block duplicates and handle save/use failures', async ({ page }) => {
  const child = { id: 8, todo_id: 1, title: 'Read notes', position: 0, completed: true, created_at: initial.created_at };
  let template: Template | null = null;
  let saves = 0;
  let uses = 0;
  let failSave = true;
  let failUse = true;
  await page.route('**/api/todos', route => route.fulfill({ json: [{ ...initial, subtasks: [child] }] }));
  await page.route('**/api/templates', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: template ? [template] : [] });
    saves++;
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({
      name: 'Monthly review', title_template: initial.title, priority: 'high',
      is_recurring: true, reminder_minutes: 60, due_date_offset_minutes: 1440,
      subtasks: [{ title: 'Read notes', position: 0 }],
    });
    expect(body).not.toHaveProperty('tags');
    expect(body).not.toHaveProperty('due_date');
    if (failSave) return route.fulfill({ status: 400, json: { error: 'Template save unavailable' } });
    await new Promise(resolve => setTimeout(resolve, 200));
    template = { ...body, id: 7, user_id: 1, category: 'Work', description: null, subtasks_json: JSON.stringify(body.subtasks), created_at: initial.created_at };
    return route.fulfill({ status: 201, json: template });
  });
  await page.route('**/api/templates/7/use', async route => {
    uses++;
    if (failUse) return route.fulfill({ status: 500, json: { error: 'Template use unavailable' } });
    return route.fulfill({ status: 201, json: {
      ...initial, id: 2, subtasks: [{ ...child, id: 9, todo_id: 2, completed: false }],
    } });
  });
  await page.route('**/api/templates/7', route => route.fulfill({ json: { success: true } }));
  await page.goto('/');
  await page.getByRole('listitem').filter({ hasText: initial.title }).getByRole('button', { name: 'Save as Template' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Subtask checklist (one title per line)')).toHaveValue('Read notes');
  await dialog.getByLabel('Template name', { exact: true }).fill('Monthly review');
  await dialog.getByLabel('Category (optional)').fill('Work');
  await expect(dialog.getByLabel('Due-date offset (minutes after use)')).toHaveAttribute('required', '');
  await dialog.getByRole('button', { name: 'Save Template', exact: true }).click();
  expect(saves).toBe(0);
  await dialog.getByLabel('Due-date offset (minutes after use)').fill('1440');
  await dialog.getByRole('button', { name: 'Save Template', exact: true }).click();
  await expect(dialog.getByText('Template save unavailable')).toBeVisible();
  await expect(dialog.getByLabel('Template name', { exact: true })).toHaveValue('Monthly review');
  failSave = false;
  await dialog.getByRole('button', { name: 'Save Template', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Saving template...' })).toBeDisabled();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('combobox', { name: 'Use Template', exact: true }).selectOption('7');
  await expect(page.getByText('Template use unavailable')).toBeVisible();
  expect(saves).toBe(2);
  failUse = false;
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  await page.getByRole('button', { name: 'Use template Monthly review', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Weekly review', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Templates', exact: true }).click();
  page.once('dialog', prompt => prompt.accept());
  await page.getByRole('button', { name: 'Delete template Monthly review' }).click();
  await expect(dialog.getByText(/No templates yet/)).toBeVisible();
  expect(uses).toBe(2);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByText('Weekly review', { exact: true })).toHaveCount(2);
});

test('imports show errors, refresh todos and tags, and export files without navigation', async ({ page }) => {
  let imported = false;
  let attempts = 0;
  await page.route('**/api/todos', route => route.fulfill({ json: imported ? [initial] : [] }));
  await page.route('**/api/tags', route => route.fulfill({ json: imported ? [workTag] : [] }));
  await page.route('**/api/todos/import', async route => {
    attempts++;
    expect(route.request().postDataJSON()).toEqual({ version: 1, todos: [] });
    if (attempts === 1) return route.fulfill({ status: 400, json: { error: 'Failed to import todos. Please check the file format.' } });
    await new Promise(resolve => setTimeout(resolve, 200));
    imported = true;
    return route.fulfill({ json: { success: true, imported: 1, tagsCreated: 1, tagsReused: 0 } });
  });
  await page.route('**/api/todos/export?format=json', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ version: 1, todos: [] }),
  }));
  await page.goto('/');
  const fileInput = page.getByLabel('Import JSON file', { exact: true });
  await fileInput.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(page.getByText('Invalid JSON format', { exact: true })).toBeVisible();
  expect(attempts).toBe(0);
  const file = { name: 'todos.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, todos: [] })) };
  await fileInput.setInputFiles(file);
  await expect(page.getByText('Failed to import todos. Please check the file format.')).toBeVisible();
  await fileInput.setInputFiles(file);
  await expect(page.getByRole('button', { name: 'Working...' })).toBeDisabled();
  await expect(page.getByText('Successfully imported 1 todos')).toBeVisible();
  await expect(page.getByText('Weekly review', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select tag Work' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^todos-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page).toHaveURL('/');
  expect(attempts).toBe(2);
});

test('calendar groups Singapore dates, limits overflow and retains URL month with accessible details', async ({ page }) => {
  const todos = Array.from({ length: 5 }, (_, index) => ({
    ...initial, id: index + 1, title: `Calendar task ${index + 1}`, due_date: '2026-02-28T16:30:00Z',
  }));
  await page.route('**/api/todos', route => route.fulfill({ json: [...todos, { ...initial, id: 6, title: 'Undated', due_date: null }] }));
  await page.route('**/api/holidays?*', route => route.fulfill({ json: {
    holidays: [{ id: 1, date: '2026-03-01', name: 'Test holiday' }],
  } }));
  await page.goto('/calendar?month=2026-03');
  await expect(page.getByRole('heading', { name: 'March 2026', exact: true })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await expect(page.locator('tbody td button')).toHaveCount(42);
  const day = page.getByRole('button', { name: /Sunday, 1 March 2026: 5 todos/ });
  await expect(day.getByText('+2 more', { exact: true })).toBeVisible();
  await expect(page.getByText('Undated', { exact: true })).toHaveCount(0);
  await day.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByText('Calendar task 5')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(day).toBeFocused();
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page).toHaveURL('/calendar?month=2026-04');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'April 2026', exact: true })).toBeVisible();
});

test('completed imports distinguish a reload failure and export errors remain visible', async ({ page }) => {
  let imported = false;
  let imports = 0;
  await page.route('**/api/todos', route => {
    return route.fulfill(!imported ? { json: [] } : { status: 500, json: { error: 'List unavailable' } });
  });
  await page.route('**/api/todos/import', route => {
    imports++;
    imported = true;
    return route.fulfill({ json: { success: true, imported: 2, tagsCreated: 0, tagsReused: 0 } });
  });
  await page.route('**/api/todos/export?format=csv', route => route.fulfill({
    status: 500, json: { error: 'CSV export unavailable' },
  }));
  await page.goto('/');
  await expect(page.getByText('You have no todos yet.', { exact: true })).toBeVisible();
  await page.getByLabel('Import JSON file', { exact: true }).setInputFiles({
    name: 'todos.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, todos: [] })),
  });
  await expect(page.getByText('Successfully imported 2 todos')).toBeVisible();
  await expect(page.getByText(/Import completed, but the list could not reload: List unavailable/)).toBeVisible();
  await expect(page.getByText(/Refresh the page; do not import again/)).toBeVisible();
  expect(imports).toBe(1);
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByText('CSV export unavailable', { exact: true })).toBeVisible();
});

test('invalid calendar months use Singapore now and a failed load can be retried', async ({ page }) => {
  let fail = true;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-02-28T16:30:00Z') });
  await page.route('**/api/todos', route => route.fulfill(fail
    ? { status: 500, json: { error: 'Calendar data unavailable' } } : { json: [] }));
  await page.route('**/api/holidays?*', route => route.fulfill({ json: { holidays: [] } }));
  await page.goto('/calendar?month=2026-13');
  await expect(page.getByText('Calendar data unavailable', { exact: false })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry loading calendar' }).click();
  await expect(page.getByRole('heading', { name: 'March 2026', exact: true })).toBeVisible();
  await expect(page.getByText('No todos due in this calendar view.')).toBeVisible();
  await expect(page.locator('[aria-current="date"]')).toHaveAttribute('aria-label', /1 March 2026/);
  expect(errors).toEqual([]);
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

test('search, tag and advanced filters work with saved presets', async ({ page }) => {
  await page.clock.install();
  const tagged = {
    ...initial,
    subtasks: [{
      id: 5, todo_id: initial.id, title: 'Send report', completed: false,
      position: 0, created_at: initial.created_at,
    }],
    tags: [workTag],
  };
  const other = { ...initial, id: 2, title: 'Project setup', priority: 'medium' as const };
  await page.route('**/api/tags', route => route.fulfill({ json: [workTag] }));
  await page.route('**/api/todos', route => route.fulfill({ json: [tagged, other] }));
  await page.goto('/');

  await page.getByLabel('Search todos and subtasks').fill('report');
  await page.clock.fastForward(300);
  await expect(page.getByText('Weekly review', { exact: true })).toBeVisible();
  await expect(page.getByText('Project setup', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByText('Project setup', { exact: true })).toBeVisible();

  await page.locator('#priority-filter').selectOption('high');
  await page.locator('#tag-filter').selectOption('6');
  await page.getByRole('button', { name: '▶ Advanced' }).click();
  await page.getByLabel('Completion status').selectOption('incomplete');
  await page.getByLabel('Due Date From').fill('2099-01-01');
  await page.getByRole('button', { name: 'Save Filter' }).click();
  const presetDialog = page.getByRole('dialog', { name: 'Save Filter Preset' });
  await presetDialog.getByLabel('Preset name').fill('Future Work');
  await presetDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(presetDialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Future Work', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Clear All' }).click();
  await page.getByRole('button', { name: 'Future Work', exact: true }).click();
  await expect(page.getByText('Weekly review', { exact: true })).toBeVisible();
  await expect(page.getByText('Project setup', { exact: true })).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: '▶ Advanced' }).click();
  await expect(page.getByRole('button', { name: 'Future Work', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Future Work', exact: true }).click();
  await expect(page.getByText('Weekly review', { exact: true })).toBeVisible();
  await expect(page.getByText('Project setup', { exact: true })).toHaveCount(0);
});

test('tags can be selected for todos and created, edited and deleted', async ({ page }) => {
  const existing = { ...initial, id: 2, title: 'Existing task' };
  let lastTagName = '';
  await page.route('**/api/tags', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [workTag] });
    const body = route.request().postDataJSON();
    lastTagName = body.name;
    return route.fulfill({ status: 201, json: { ...workTag, id: 7, name: body.name, color: body.color } });
  });
  await page.route('**/api/tags/7', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      lastTagName = body.name;
      return route.fulfill({ json: { ...workTag, id: 7, name: body.name, color: body.color } });
    }
    return route.fulfill({ json: { success: true } });
  });
  let submittedTags: number[] = [];
  await page.route('**/api/todos', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [existing] });
    const body = route.request().postDataJSON();
    submittedTags = body.tag_ids;
    return route.fulfill({ status: 201, json: { ...initial, id: 3, title: body.title, tags: [workTag] } });
  });
  await page.goto('/');
  await page.getByLabel('Title', { exact: true }).fill('Tagged task');
  await page.getByRole('button', { name: 'Select tag Work' }).click();
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Tagged task', { exact: true })).toBeVisible();
  expect(submittedTags).toEqual([workTag.id]);
  await page.getByRole('button', { name: 'Filter todos by Work' }).click();
  await expect(page.getByText('Existing task', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Manage Tags' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage Tags' });
  await dialog.getByLabel('New tag name').fill('Project');
  await dialog.getByRole('button', { name: 'Create Tag' }).click();
  await expect(dialog.getByText('Project', { exact: true })).toBeVisible();
  await dialog.locator('li').filter({ hasText: 'Project' }).getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel('Edit tag name').fill('Projects');
  await dialog.getByRole('button', { name: 'Update Tag' }).click();
  await expect(dialog.getByText('Projects', { exact: true })).toBeVisible();
  page.on('dialog', browserDialog => browserDialog.accept());
  await dialog.locator('li').filter({ hasText: 'Projects' }).getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByText('Projects', { exact: true })).toHaveCount(0);
  expect(lastTagName).toBe('Projects');
});
