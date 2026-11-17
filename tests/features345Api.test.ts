import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const testState = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-features-api-'));
  const previous = process.cwd();
  process.chdir(directory);
  return {
    directory,
    previous,
    session: null as { userId: number; username: string } | null,
  };
});

vi.mock('@/lib/auth', () => ({ getSession: async () => testState.session }));

const { db, todoDB, userDB } = await import('@/lib/db');
const itemRoute = await import('@/app/api/todos/[id]/route');
const subtasksRoute = await import('@/app/api/todos/[id]/subtasks/route');
const subtaskRoute = await import('@/app/api/subtasks/[id]/route');
const notificationRoute = await import('@/app/api/notifications/check/route');
const { getSingaporeNow, toSingaporeISO } = await import('@/lib/timezone');
const { unlinkSync, rmdirSync } = await import('node:fs');
const owner = userDB.create('feature-owner');
const other = userDB.create('feature-other');

function request(path: string, method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const context = (id: number | string) => ({
  params: Promise.resolve({ id: String(id) }),
});

beforeEach(() => {
  db.prepare('DELETE FROM todos').run();
  testState.session = { userId: owner.id, username: owner.username };
});

afterAll(() => {
  db.close();
  process.chdir(testState.previous);
  unlinkSync(`${testState.directory}/todos.db`);
  rmdirSync(testState.directory);
});

describe('recurring todo API', () => {
  it('completes and creates the next occurrence atomically with tags and reminders', async () => {
    const tagId = Number(
      db.prepare('INSERT INTO tags(user_id, name) VALUES (?, ?)')
        .run(owner.id, 'habit').lastInsertRowid,
    );
    const todo = todoDB.create({
      user_id: owner.id,
      title: 'Monthly task',
      due_date: '2025-01-31T09:00:00.000+08:00',
      priority: 'high',
      is_recurring: true,
      recurrence_pattern: 'monthly',
      reminder_minutes: 60,
      tag_ids: [tagId],
    });

    const response = await itemRoute.PUT(
      request(`/api/todos/${todo.id}`, 'PUT', { completed: true }),
      context(todo.id),
    );
    expect(response?.status).toBe(200);
    const result = await response!.json();
    expect(result.todo.completed).toBe(true);
    expect(result.nextInstance).toMatchObject({
      title: todo.title,
      completed: false,
      due_date: '2025-02-28T09:00:00.000+08:00',
      priority: 'high',
      recurrence_pattern: 'monthly',
      reminder_minutes: 60,
      tags: [{ id: tagId }],
    });

    await itemRoute.PUT(
      request(`/api/todos/${todo.id}`, 'PUT', { completed: true }),
      context(todo.id),
    );
    expect(todoDB.findAllByUser(owner.id)).toHaveLength(2);
  });

  it('rolls back completion when next-instance creation fails', () => {
    const todo = todoDB.create({
      user_id: owner.id,
      title: 'Weekly task',
      due_date: '2025-11-10T14:00:00+08:00',
      is_recurring: true,
      recurrence_pattern: 'weekly',
    });

    expect(() => todoDB.completeAndCreateNext(
      todo.id,
      owner.id,
      { completed: true },
      () => { throw new Error('date calculation failed'); },
    )).toThrow('date calculation failed');
    expect(todoDB.findById(todo.id, owner.id)?.completed).toBe(false);
    expect(todoDB.findAllByUser(owner.id)).toHaveLength(1);
  });
});

describe('reminder API', () => {
  it('returns only due-window reminders and re-arms after reminder settings change', async () => {
    const now = getSingaporeNow();
    const dueDate = toSingaporeISO(new Date(now.getTime() + 14 * 60_000));
    const todo = todoDB.create({
      user_id: owner.id,
      title: 'Soon',
      due_date: dueDate,
      reminder_minutes: 15,
    });

    const check = await notificationRoute.GET();
    expect((await check.json()).data.map((item: { id: number }) => item.id)).toContain(todo.id);

    const stamped = await itemRoute.PUT(
      request(`/api/todos/${todo.id}`, 'PUT', {
        last_notification_sent: toSingaporeISO(getSingaporeNow()),
      }),
      context(todo.id),
    );
    expect((await stamped!.json()).last_notification_sent).not.toBeNull();
    const afterStamp = await notificationRoute.GET();
    expect((await afterStamp.json()).data).toEqual([]);

    await itemRoute.PUT(
      request(`/api/todos/${todo.id}`, 'PUT', { reminder_minutes: 30 }),
      context(todo.id),
    );
    expect(todoDB.findById(todo.id, owner.id)?.last_notification_sent).toBeNull();
  });

  it('requires authentication', async () => {
    testState.session = null;
    expect((await notificationRoute.GET()).status).toBe(401);
  });
});

describe('subtask API', () => {
  it('adds in position order, updates independently, and does not compact positions on delete', async () => {
    const todo = todoDB.create({ user_id: owner.id, title: 'Parent' });
    const first = await subtasksRoute.POST(
      request(`/api/todos/${todo.id}/subtasks`, 'POST', { title: ' First ' }),
      context(todo.id),
    );
    const second = await subtasksRoute.POST(
      request(`/api/todos/${todo.id}/subtasks`, 'POST', { title: 'Second' }),
      context(todo.id),
    );
    expect(first?.status).toBe(201);
    expect(second?.status).toBe(201);
    const firstSubtask = await first!.json();
    const secondSubtask = await second!.json();
    expect([firstSubtask.position, secondSubtask.position]).toEqual([0, 1]);

    expect((await subtaskRoute.PUT(
      request(`/api/subtasks/${secondSubtask.id}`, 'PUT', { completed: true }),
      context(secondSubtask.id),
    ))?.status).toBe(200);
    expect((await subtaskRoute.DELETE(
      request(`/api/subtasks/${firstSubtask.id}`, 'DELETE'),
      context(firstSubtask.id),
    )).status).toBe(200);

    const third = await subtasksRoute.POST(
      request(`/api/todos/${todo.id}/subtasks`, 'POST', { title: 'Third' }),
      context(todo.id),
    );
    expect((await third!.json()).position).toBe(2);
    expect(todoDB.findById(todo.id, owner.id)?.subtasks).toMatchObject([
      { title: 'Second', completed: true, position: 1 },
      { title: 'Third', completed: false, position: 2 },
    ]);
  });

  it('rejects invalid titles and hides cross-user parent/child resources', async () => {
    const parent = todoDB.create({ user_id: owner.id, title: 'Private parent' });
    const privateTodo = todoDB.create({ user_id: other.id, title: 'Other parent' });
    db.prepare('INSERT INTO subtasks(todo_id,title) VALUES (?,?)')
      .run(privateTodo.id, 'Private child');
    const privateSubtask = db.prepare('SELECT id FROM subtasks WHERE todo_id = ?')
      .get(privateTodo.id) as { id: number };
    const privateId = privateSubtask.id;

    expect((await subtasksRoute.POST(
      request(`/api/todos/${parent.id}/subtasks`, 'POST', { title: '  ' }),
      context(parent.id),
    ))?.status).toBe(400);
    expect((await subtasksRoute.POST(
      request(`/api/todos/${privateTodo.id}/subtasks`, 'POST', { title: 'No access' }),
      context(privateTodo.id),
    ))?.status).toBe(404);
    expect((await subtaskRoute.PUT(
      request(`/api/subtasks/${privateId}`, 'PUT', { completed: true }),
      context(privateId),
    ))?.status).toBe(404);
    expect((await subtaskRoute.DELETE(
      request(`/api/subtasks/${privateId}`, 'DELETE'),
      context(privateId),
    )).status).toBe(404);
    expect(db.prepare('SELECT completed FROM subtasks WHERE id = ?').get(privateId))
      .toMatchObject({ completed: 0 });
  });

  it('requires authentication for every subtask mutation', async () => {
    const todo = todoDB.create({ user_id: owner.id, title: 'Parent' });
    const subtask = Number(
      db.prepare('INSERT INTO subtasks(todo_id,title) VALUES (?,?)')
        .run(todo.id, 'Child').lastInsertRowid,
    );
    testState.session = null;

    expect((await subtasksRoute.POST(
      request(`/api/todos/${todo.id}/subtasks`, 'POST', { title: 'Another child' }),
      context(todo.id),
    ))?.status).toBe(401);
    expect((await subtaskRoute.PUT(
      request(`/api/subtasks/${subtask}`, 'PUT', { completed: true }),
      context(subtask),
    ))?.status).toBe(401);
    expect((await subtaskRoute.DELETE(
      request(`/api/subtasks/${subtask}`, 'DELETE'),
      context(subtask),
    )).status).toBe(401);
  });

  it('deletes child rows when the parent todo is deleted', async () => {
    const todo = todoDB.create({ user_id: owner.id, title: 'Delete parent' });
    await subtasksRoute.POST(
      request(`/api/todos/${todo.id}/subtasks`, 'POST', { title: 'Child' }),
      context(todo.id),
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM subtasks WHERE todo_id = ?')
      .get(todo.id)).toMatchObject({ count: 1 });
    await itemRoute.DELETE(
      request(`/api/todos/${todo.id}`, 'DELETE'),
      context(todo.id),
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM subtasks WHERE todo_id = ?')
      .get(todo.id)).toMatchObject({ count: 0 });
  });
});
