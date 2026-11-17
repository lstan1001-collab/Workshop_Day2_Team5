import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-productivity-api-'));
  const previous = process.cwd();
  process.chdir(directory);
  return { directory, previous, session: null as { userId: number; username: string } | null };
});
vi.mock('@/lib/auth', () => ({ getSession: async () => state.session }));

const { db, holidayDB, subtaskDB, tagDB, templateDB, todoDB, userDB } = await import('@/lib/db');
const templates = await import('@/app/api/templates/route');
const template = await import('@/app/api/templates/[id]/route');
const useTemplate = await import('@/app/api/templates/[id]/use/route');
const exports = await import('@/app/api/todos/export/route');
const imports = await import('@/app/api/todos/import/route');
const holidays = await import('@/app/api/holidays/route');
const { toExport } = await import('@/lib/dataTransfer');
const { unlinkSync, rmdirSync } = await import('node:fs');
const owner = userDB.create('productivity-owner');
const other = userDB.create('productivity-other');
const context = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
function request(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost:3000/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  db.exec('DELETE FROM templates; DELETE FROM todos; DELETE FROM tags; DELETE FROM holidays;');
  state.session = { userId: owner.id, username: owner.username };
});
afterAll(() => {
  db.close();
  process.chdir(state.previous);
  unlinkSync(`${state.directory}/todos.db`);
  rmdirSync(state.directory);
});

it('authenticates every endpoint before validating input or reading records', async () => {
  state.session = null;
  const responses = await Promise.all([
    templates.GET(),
    templates.POST(request('templates', 'POST', {})),
    template.PUT(request('templates/invalid', 'PUT', {}), context('invalid')),
    template.DELETE(request('templates/invalid', 'DELETE'), context('invalid')),
    useTemplate.POST(request('templates/invalid/use', 'POST'), context('invalid')),
    exports.GET(request('todos/export?format=invalid')),
    imports.POST(request('todos/import', 'POST', {})),
    holidays.GET(request('holidays?month=invalid')),
  ]);
  expect(responses.map((response) => response.status)).toEqual(Array(8).fill(401));
});

describe('templates', () => {
  it('creates a normalized snapshot, instantiates fresh relations and preserves todos on deletion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T16:29:00Z'));
    try {
      const created = await templates.POST(request('templates', 'POST', {
        name: ' Weekly review ', title_template: ' Review work ',
        is_recurring: true, recurrence_pattern: 'weekly', priority: 'high',
        reminder_minutes: 15, due_date_offset_minutes: 1,
        subtasks: [{ title: ' Read notes ', position: 99 }],
      }));
      expect(created.status).toBe(201);
      const saved = await created.json();
      expect(saved).toMatchObject({
        name: 'Weekly review', title_template: 'Review work',
        subtasks_json: '[{"title":"Read notes","position":0}]',
      });
      expect(await (await templates.GET()).json()).toEqual([saved]);
      const response = await useTemplate.POST(request(`templates/${saved.id}/use`, 'POST'), context(saved.id));
      expect(response.status).toBe(201);
      const todo = await response.json();
      expect(todo).toMatchObject({
        title: 'Review work', priority: 'high', is_recurring: true,
        recurrence_pattern: 'weekly', reminder_minutes: 15,
        due_date: '2026-03-01T00:30:00.000+08:00', completed: false,
        tags: [], subtasks: [{ title: 'Read notes', completed: false, position: 0 }],
      });
      await template.DELETE(request(`templates/${saved.id}`, 'DELETE'), context(saved.id));
      expect(todoDB.findById(todo.id, owner.id)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: ' ' },
    { priority: 'urgent' },
    { is_recurring: true, recurrence_pattern: 'daily' },
    { reminder_minutes: 15 },
    { due_date_offset_minutes: 0 },
    { due_date_offset_minutes: 0.5 },
    { due_date_offset_minutes: Number.MAX_SAFE_INTEGER },
    { user_id: 999 },
    { subtasks: [{ title: ' ', position: 0 }] },
  ])('rejects invalid template fields without writes: %j', async (invalid) => {
    const response = await templates.POST(request('templates', 'POST', {
      name: 'Valid', title_template: 'Valid', ...invalid,
    }));
    expect(response.status).toBe(400);
    expect(templateDB.findAllByUser(owner.id)).toEqual([]);
  });

  it('validates partial updates against existing recurrence/reminder requirements', async () => {
    const saved = templateDB.create(owner.id, {
      name: 'Reminder', title_template: 'Follow up', reminder_minutes: 60, due_date_offset_minutes: 120,
    });
    const invalid = await template.PUT(
      request(`templates/${saved.id}`, 'PUT', { due_date_offset_minutes: null }), context(saved.id),
    );
    expect(invalid.status).toBe(400);
    const valid = await template.PUT(
      request(`templates/${saved.id}`, 'PUT', { name: ' Renamed ' }), context(saved.id),
    );
    expect(await valid.json()).toMatchObject({
      name: 'Renamed', title_template: 'Follow up', reminder_minutes: 60, due_date_offset_minutes: 120,
    });
    const noDate = await template.PUT(
      request(`templates/${saved.id}`, 'PUT', { reminder_minutes: null, due_date_offset_minutes: null }),
      context(saved.id),
    );
    expect(noDate.status).toBe(200);
  });

  it('isolates templates by user and rejects malformed IDs', async () => {
    const saved = templateDB.create(other.id, { name: 'Private', title_template: 'Hidden' });
    expect(await (await templates.GET()).json()).toEqual([]);
    expect((await template.PUT(request('templates/1', 'PUT', { name: 'Wrong' }), context(saved.id))).status).toBe(404);
    expect((await template.DELETE(request('templates/1', 'DELETE'), context(saved.id))).status).toBe(404);
    expect((await useTemplate.POST(request('templates/1/use', 'POST'), context(saved.id))).status).toBe(404);
    expect((await useTemplate.POST(request('templates/x/use', 'POST'), context('1e0'))).status).toBe(400);
    expect(templateDB.findById(saved.id, other.id)?.name).toBe('Private');
  });

  it('reports corrupt stored checklists rather than silently creating incomplete todos', async () => {
    const saved = templateDB.create(owner.id, { name: 'Corrupt', title_template: 'No partial work' });
    db.prepare('UPDATE templates SET subtasks_json = ? WHERE id = ?').run('{broken', saved.id);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await useTemplate.POST(request('templates/1/use', 'POST'), context(saved.id));
      expect(response.status).toBe(500);
      expect(log).toHaveBeenCalled();
      expect(todoDB.findAllByUser(owner.id)).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('export/import', () => {
  it('round-trips an owned snapshot with tags, completed subtasks, historical dates and new IDs', async () => {
    const tag = tagDB.create(owner.id, { name: 'Work', color: '#123456' });
    const source = todoDB.create({
      user_id: owner.id, title: 'Historical recurring task', due_date: '2025-01-02T09:30:00+08:00',
      priority: 'high', is_recurring: true, recurrence_pattern: 'monthly', reminder_minutes: 60,
      tag_ids: [tag.id],
    });
    const child = subtaskDB.create(source.id, owner.id, { title: 'Finished step' })!;
    subtaskDB.update(child.id, owner.id, { completed: true });
    todoDB.create({ user_id: other.id, title: 'Private foreign todo' });

    const response = await exports.GET(request('todos/export'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const payload = await response.json();
    expect(payload.todos).toHaveLength(1);
    expect(payload.todos[0]).not.toHaveProperty('id');
    expect(payload.todos[0]).not.toHaveProperty('user_id');
    expect(payload.todos[0].subtasks[0]).toEqual({ title: 'Finished step', completed: true, position: 0 });
    const reused = tagDB.create(other.id, { name: 'work', color: '#abcdef' });
    state.session = { userId: other.id, username: other.username };
    const imported = await imports.POST(request('todos/import', 'POST', payload));
    expect(await imported.json()).toEqual({ success: true, imported: 1, tagsCreated: 0, tagsReused: 1 });
    const copy = todoDB.findAllByUser(other.id).find((todo) => todo.title === source.title)!;
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      user_id: other.id, created_at: source.created_at, due_date: '2025-01-02T09:30:00.000+08:00',
      last_notification_sent: null, subtasks: [{ title: 'Finished step', completed: true }],
      tags: [{ id: reused.id, color: '#abcdef' }],
    });
  });

  it('validates the entire file before writes and distinguishes malformed JSON and media types', async () => {
    const source = todoDB.create({ user_id: owner.id, title: 'Valid source' });
    const payload = toExport([source]);
    const invalid = { ...payload, todos: [...payload.todos, { ...payload.todos[0], title: ' ' }] };
    const response = await imports.POST(request('todos/import', 'POST', invalid));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Failed to import todos. Please check the file format.' });
    expect(todoDB.findAllByUser(owner.id)).toHaveLength(1);
    const broken = await imports.POST(new NextRequest('http://localhost/api/todos/import', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }));
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: 'Invalid JSON format' });
    const wrongType = await imports.POST(new NextRequest('http://localhost/api/todos/import', {
      method: 'POST', body: 'csv,data',
    }));
    expect(wrongType.status).toBe(415);
  });

  it.each([
    { due_date: '2026-02-30T10:00' },
    { reminder_minutes: 17 },
    { is_recurring: true, due_date: null },
    { created_at: 'yesterday' },
    { tags: [{ name: ' ', color: '#123456' }] },
  ])('rejects invalid import values: %j', async (invalid) => {
    const source = todoDB.create({ user_id: owner.id, title: 'Source' });
    const payload = toExport([source]);
    payload.todos[0] = { ...payload.todos[0], ...invalid };
    expect((await imports.POST(request('todos/import', 'POST', payload))).status).toBe(400);
    expect(todoDB.findAllByUser(owner.id)).toHaveLength(1);
  });

  it('rolls back earlier todos and new tags when a later insert fails', async () => {
    const source = todoDB.create({ user_id: owner.id, title: 'Source' });
    const payload = toExport([source, { ...source, title: 'Fail' }]);
    payload.todos[0].tags = [{ name: 'New tag', color: '#123456' }];
    db.exec(`CREATE TEMP TRIGGER fail_productivity_import BEFORE INSERT ON todos
      WHEN NEW.title = 'Fail' BEGIN SELECT RAISE(ABORT, 'forced failure'); END;`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await imports.POST(request('todos/import', 'POST', payload))).status).toBe(500);
      expect(todoDB.findAllByUser(owner.id)).toHaveLength(1);
      expect(tagDB.findAllByUser(owner.id)).toEqual([]);
      expect(log).toHaveBeenCalled();
    } finally {
      db.exec('DROP TRIGGER fail_productivity_import');
      log.mockRestore();
    }
  });

  it('emits RFC 4180 CSV, neutralizes formulas and uses the Singapore download date', async () => {
    todoDB.create({ user_id: owner.id, title: 'Buy milk, "bread"\nand eggs' });
    todoDB.create({ user_id: owner.id, title: '=HYPERLINK("https://example.test")' });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-28T16:01:00Z'));
    try {
      const response = await exports.GET(request('todos/export?format=csv'));
      expect(response.headers.get('content-disposition')).toContain('todos-2026-03-01.csv');
      const csv = await response.text();
      expect(csv).toMatch(/^ID,Title,Completed,Due Date,Priority,Recurring,Pattern,Reminder\r\n/);
      expect(csv).toContain('"Buy milk, ""bread""\nand eggs"');
      expect(csv).toContain(`"'=HYPERLINK(""https://example.test"")"`);
      expect((await exports.GET(request('todos/export?format=xml'))).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports empty backups', async () => {
    const payload = await (await exports.GET(request('todos/export'))).json();
    expect(payload.todos).toEqual([]);
    expect(await (await imports.POST(request('todos/import', 'POST', payload))).json())
      .toEqual({ success: true, imported: 0, tagsCreated: 0, tagsReused: 0 });
  });
});

describe('holiday API', () => {
  it('returns global holidays for all dates or the exact visible six-week grid', async () => {
    holidayDB.upsert('2025-02-23', 'Leading grid fixture');
    holidayDB.upsert('2025-04-05', 'Trailing grid fixture');
    holidayDB.upsert('2025-04-06', 'Outside grid fixture');
    const scoped = await holidays.GET(request('holidays?year=2025&month=03'));
    expect((await scoped.json()).holidays.map((item: { date: string }) => item.date))
      .toEqual(['2025-02-23', '2025-04-05']);
    expect((await (await holidays.GET(request('holidays'))).json()).holidays).toHaveLength(3);
  });

  it('handles low and boundary four-digit years without Date.UTC century remapping', async () => {
    holidayDB.upsert('0099-01-01', 'Low year fixture');
    holidayDB.upsert('9999-12-31', 'High year fixture');
    for (const [year, month, date] of [['0099', '1', '0099-01-01'], ['9999', '12', '9999-12-31']]) {
      const response = await holidays.GET(request(`holidays?year=${year}&month=${month}`));
      expect(response.status).toBe(200);
      expect((await response.json()).holidays).toEqual([expect.objectContaining({ date })]);
    }
  });

  it('seeds published holidays repeatably and exposes them through the calendar API', async () => {
    const { seedHolidays } = await import('../scripts/seed-holidays');
    const count = holidayDB.findAll().length;
    seedHolidays();
    expect(holidayDB.findAll()).toHaveLength(count);
    const response = await holidays.GET(request('holidays?year=2026&month=12'));
    expect((await response.json()).holidays).toContainEqual(
      expect.objectContaining({ date: '2026-12-25', name: 'Christmas Day' }),
    );
  });

  it.each(['year=2025', 'month=3', 'year=2025&month=13', 'year=abc&month=1', 'year=2025&month='])(
    'rejects malformed or incomplete ranges: %s', async (query) => {
      expect((await holidays.GET(request(`holidays?${query}`))).status).toBe(400);
    },
  );
});
