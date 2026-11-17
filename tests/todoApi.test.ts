import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const testState = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-api-test-'));
  const previous = process.cwd();
  process.chdir(directory);
  return { directory, previous, session: { userId: 1, username: 'owner' } as { userId: number; username: string } | null };
});

vi.mock('@/lib/auth', () => ({ getSession: async () => testState.session }));

const { db, userDB, todoDB } = await import('@/lib/db');
const collection = await import('@/app/api/todos/route');
const item = await import('@/app/api/todos/[id]/route');
const { unlinkSync, rmdirSync } = await import('node:fs');
const owner = userDB.create('owner');
const other = userDB.create('other');

function request(path = '/api/todos', method = 'GET', body?: unknown) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

beforeEach(() => {
  db.prepare('DELETE FROM todos').run();
  db.prepare('DELETE FROM tags').run();
  testState.session = { userId: owner.id, username: owner.username };
});
afterAll(() => {
  db.close();
  process.chdir(testState.previous);
  unlinkSync(`${testState.directory}/todos.db`);
  rmdirSync(testState.directory);
});

describe('todo routes with real SQLite', () => {
  it('requires authentication before parsing or accessing data on every route', async () => {
    testState.session = null;
    const responses = await Promise.all([
      collection.GET(request()), collection.POST(request('/api/todos', 'POST', {})),
      item.GET(request(), context('invalid')),
      item.PUT(request('/api/todos/1', 'PUT', {}), context(1)),
      item.DELETE(request('/api/todos/1', 'DELETE'), context(1)),
    ]);
    expect(responses.map((response) => response?.status)).toEqual([401, 401, 401, 401, 401]);
  });

  it('persists defaults, priority updates and partial completion without resetting fields', async () => {
    const response = await collection.POST(request('/api/todos', 'POST', { title: '  New todo  ' }));
    expect(response?.status).toBe(201);
    const todo = await response!.json();
    expect(todo).toMatchObject({ title: 'New todo', priority: 'medium', completed: false, due_date: null, user_id: owner.id });
    await item.PUT(request('', 'PUT', { priority: 'high' }), context(todo.id));
    await item.PUT(request('', 'PUT', { completed: true }), context(todo.id));
    const loaded = await item.GET(request(), context(todo.id));
    expect(await loaded.json()).toMatchObject({ priority: 'high', completed: true });
    const all = await collection.GET(request('/api/todos?priority=high'));
    expect(await all.json()).toHaveLength(1);
    expect(await (await collection.GET(request('/api/todos?priority=low'))).json()).toEqual([]);
    expect((await collection.GET(request('/api/todos?priority=urgent'))).status).toBe(400);
  });

  it('hides other users records and rejects updates without modifying rows', async () => {
    const todo = todoDB.create({ user_id: other.id, title: 'Private' });
    expect(await (await collection.GET(request())).json()).toEqual([]);
    expect((await item.GET(request(), context(todo.id))).status).toBe(404);
    expect((await item.PUT(request('', 'PUT', { title: 'Hacked' }), context(todo.id)))?.status).toBe(404);
    expect((await item.DELETE(request('', 'DELETE'), context(todo.id))).status).toBe(404);
    expect(todoDB.findById(todo.id, other.id)?.title).toBe('Private');
  });

  it('returns 400 for invalid input and never partially writes', async () => {
    const todo = todoDB.create({ user_id: owner.id, title: 'Original', priority: 'high' });
    for (const body of [{ priority: 'urgent' }, { priority: null }, { title: 4 }, { user_id: other.id }, { due_date: 'not-a-date' }]) {
      expect((await item.PUT(request('', 'PUT', body), context(todo.id)))?.status).toBe(400);
      expect(todoDB.findById(todo.id, owner.id)).toEqual(todo);
    }
    const malformed = new NextRequest('http://localhost:3000/api/todos', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    });
    expect((await collection.POST(malformed))?.status).toBe(400);
    expect((await collection.POST(request('', 'POST', { title: 'Invalid', priority: 'urgent' })))?.status).toBe(400);
    const foreignTag = Number(db.prepare('INSERT INTO tags(user_id,name) VALUES (?,?)').run(other.id, 'private').lastInsertRowid);
    expect((await collection.POST(request('', 'POST', { title: 'Rollback', tag_ids: [foreignTag] })))?.status).toBe(400);
    expect(todoDB.findAllByUser(owner.id)).toHaveLength(1);
  });

  it('deletes parent and associations atomically while retaining reusable tags', async () => {
    const tagId = Number(db.prepare('INSERT INTO tags(user_id,name) VALUES (?,?)').run(owner.id, 'work').lastInsertRowid);
    const todo = todoDB.create({ user_id: owner.id, title: 'Parent', tag_ids: [tagId] });
    db.prepare('INSERT INTO subtasks(todo_id,title) VALUES (?,?)').run(todo.id, 'Child');
    const response = await item.DELETE(request('', 'DELETE'), context(todo.id));
    expect(await response.json()).toEqual({ success: true });
    expect(db.prepare('SELECT * FROM subtasks WHERE todo_id=?').all(todo.id)).toEqual([]);
    expect(db.prepare('SELECT * FROM todo_tags WHERE todo_id=?').all(todo.id)).toEqual([]);
    expect(db.prepare('SELECT * FROM tags WHERE id=?').get(tagId)).toBeDefined();
    expect(todoDB.findById(todo.id, owner.id)).toBeNull();
  });
});
