import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { rmdirSync, unlinkSync } from 'node:fs';

const state = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previous = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), 'todo-database-features-'));
  process.chdir(directory);
  return { previous, directory };
});

const { createDatabase, db, subtaskDB, todoDB, userDB } = await import('@/lib/db');
const owner = userDB.create('database-owner');
const other = userDB.create('database-other');

beforeEach(() => {
  db.prepare('DELETE FROM todos').run();
  db.prepare('DELETE FROM tags').run();
});

afterAll(() => {
  db.close();
  process.chdir(state.previous);
  unlinkSync(join(state.directory, 'todos.db'));
  rmdirSync(state.directory);
});

describe('feature schema compatibility', () => {
  it('migrates existing todos without losing data and can reopen repeatedly', () => {
    const file = join(state.directory, 'legacy.db');
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO users (id, username) VALUES (1, 'legacy');
      CREATE TABLE todos (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
        title TEXT NOT NULL
      );
      INSERT INTO todos VALUES (1, 1, 'Keep this todo');
    `);
    legacy.close();

    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const migrated = createDatabase(file);
        try {
          expect(migrated.pragma('foreign_keys', { simple: true })).toBe(1);
          expect(migrated.prepare('SELECT * FROM todos WHERE id = 1').get())
            .toMatchObject({
              title: 'Keep this todo',
              completed: 0,
              is_recurring: 0,
              recurrence_pattern: null,
              reminder_minutes: null,
              last_notification_sent: null,
            });
          migrated.prepare('INSERT INTO subtasks(todo_id,title) VALUES (1,?)')
            .run(`Child ${attempt}`);
          if (attempt === 1) {
            migrated.prepare('DELETE FROM todos WHERE id = 1').run();
            expect(migrated.prepare('SELECT * FROM subtasks').all()).toEqual([]);
          }
        } finally {
          migrated.close();
        }
      }
    } finally {
      unlinkSync(file);
    }
  });
});

describe('recurring completion persistence', () => {
  it('inherits completion-time settings, starts fresh reminders and does not copy subtasks', () => {
    const tag = Number(db.prepare('INSERT INTO tags(user_id,name) VALUES (?,?)')
      .run(owner.id, 'habit').lastInsertRowid);
    const todo = todoDB.create({
      user_id: owner.id,
      title: 'Old title',
      is_recurring: true,
      recurrence_pattern: 'daily',
      due_date: '2026-12-01T10:00:00+08:00',
      reminder_minutes: 15,
    });
    subtaskDB.create(todo.id, owner.id, { title: 'Original checklist' });
    db.prepare('UPDATE todos SET last_notification_sent = ? WHERE id = ?')
      .run('2026-12-01T09:45:00+08:00', todo.id);
    const calculate = vi.fn(() => '2026-12-08T10:00:00+08:00');
    const result = todoDB.completeAndCreateNext(todo.id, owner.id, {
      title: 'Current title',
      priority: 'high',
      recurrence_pattern: 'weekly',
      reminder_minutes: 60,
      tag_ids: [tag],
    }, calculate);

    expect(calculate).toHaveBeenCalledWith('2026-12-01T10:00:00+08:00', 'weekly');
    expect(result.todo).toMatchObject({ completed: true, subtasks: [{ title: 'Original checklist' }] });
    expect(result.nextInstance).toMatchObject({
      title: 'Current title',
      priority: 'high',
      completed: false,
      is_recurring: true,
      recurrence_pattern: 'weekly',
      reminder_minutes: 60,
      last_notification_sent: null,
      tags: [{ id: tag }],
      subtasks: [],
    });
    const repeated = todoDB.completeAndCreateNext(todo.id, owner.id, {}, calculate);
    expect(repeated.nextInstance).toBeNull();
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(todoDB.findAllByUser(owner.id)).toHaveLength(2);
  });

  it('rolls back the completion and new row if copying tags fails', () => {
    const tag = Number(db.prepare('INSERT INTO tags(user_id,name) VALUES (?,?)')
      .run(owner.id, 'rollback-tag').lastInsertRowid);
    const todo = todoDB.create({
      user_id: owner.id,
      title: 'Transactional',
      due_date: '2026-12-01T10:00:00+08:00',
      is_recurring: true,
      recurrence_pattern: 'daily',
      tag_ids: [tag],
    });
    db.exec(`CREATE TEMP TRIGGER fail_tag_copy BEFORE INSERT ON todo_tags
      BEGIN SELECT RAISE(ABORT, 'tag copy failed'); END;`);
    try {
      expect(() => todoDB.completeAndCreateNext(todo.id, owner.id,
        { title: 'Must roll back' }, () => '2026-12-02T10:00:00+08:00'))
        .toThrow('tag copy failed');
      expect(todoDB.findById(todo.id, owner.id)).toEqual(todo);
      expect(todoDB.findAllByUser(owner.id)).toHaveLength(1);
      expect(db.prepare('SELECT * FROM todo_tags').all()).toHaveLength(1);
    } finally {
      db.exec('DROP TRIGGER fail_tag_copy');
    }
  });

  it('cannot complete a foreign todo or generate an occurrence after recurrence is disabled', () => {
    const todo = todoDB.create({
      user_id: owner.id, title: 'Private recurring todo',
      due_date: '2026-12-01T10:00:00+08:00',
      is_recurring: true, recurrence_pattern: 'daily',
    });
    const calculate = vi.fn(() => '2026-12-02T10:00:00+08:00');
    expect(todoDB.completeAndCreateNext(todo.id, other.id, {}, calculate))
      .toEqual({ todo: null, nextInstance: null });
    const result = todoDB.completeAndCreateNext(todo.id, owner.id,
      { is_recurring: false, recurrence_pattern: null }, calculate);
    expect(result.todo?.completed).toBe(true);
    expect(result.nextInstance).toBeNull();
    expect(calculate).not.toHaveBeenCalled();
  });
});

describe('reminder persistence', () => {
  it.each([15, 30, 60, 120, 1440, 2880, 10080])(
    'opens a %i-minute reminder at the exact trigger instant, never early',
    (minutes) => {
      const todo = todoDB.create({
        user_id: owner.id, title: 'Reminder boundary',
        due_date: '2026-12-08T00:05:00.500+08:00',
        reminder_minutes: minutes,
      });
      const trigger = Date.parse(todo.due_date!) - minutes * 60_000;
      const before = new Date(trigger - 1).toISOString();
      const at = new Date(trigger).toISOString();

      expect(todoDB.findDueReminders(owner.id, before)).toEqual([]);
      expect(todoDB.markReminderSent(todo.id, owner.id, before)?.last_notification_sent).toBeNull();
      expect(todoDB.findDueReminders(owner.id, at).map(({ id }) => id)).toEqual([todo.id]);
      expect(todoDB.findDueReminders(other.id, at)).toEqual([]);
      expect(todoDB.markReminderSent(todo.id, other.id, at)).toBeNull();
      expect(todoDB.markReminderSent(todo.id, owner.id, at)?.last_notification_sent).toBe(at);
      expect(todoDB.findDueReminders(owner.id, at)).toEqual([]);
    },
  );

  it('preserves notification state on unrelated edits and resets it on changed settings', () => {
    const todo = todoDB.create({
      user_id: owner.id, title: 'Notification state',
      due_date: '2026-12-01T10:00:00+08:00', reminder_minutes: 15,
    });
    const stamp = '2026-12-01T09:45:00+08:00';
    todoDB.markReminderSent(todo.id, owner.id, stamp);
    expect(todoDB.update(todo.id, owner.id, { title: 'Renamed' })?.last_notification_sent).toBe(stamp);
    expect(todoDB.update(todo.id, owner.id, { due_date: todo.due_date })?.last_notification_sent).toBe(stamp);
    expect(todoDB.update(todo.id, owner.id,
      { due_date: '2026-12-01T10:05:00+08:00' })?.last_notification_sent).toBeNull();
    todoDB.markReminderSent(todo.id, owner.id, '2026-12-01T09:50:00+08:00');
    expect(todoDB.update(todo.id, owner.id, { reminder_minutes: 30 })?.last_notification_sent).toBeNull();
  });
});

describe('subtask persistence', () => {
  it('enforces ownership, preserves gaps and keeps parent and child completion independent', () => {
    const todo = todoDB.create({ user_id: owner.id, title: 'Parent' });
    const first = subtaskDB.create(todo.id, owner.id, { title: 'First' })!;
    const second = subtaskDB.create(todo.id, owner.id, { title: 'Second' })!;
    expect(subtaskDB.create(todo.id, other.id, { title: 'Not allowed' })).toBeNull();
    expect(subtaskDB.findByTodoId(todo.id, other.id)).toEqual([]);
    expect(subtaskDB.update(first.id, other.id, { completed: true })).toBeNull();
    expect(subtaskDB.delete(first.id, other.id)).toBe(false);
    subtaskDB.update(first.id, owner.id, { completed: true });
    subtaskDB.update(second.id, owner.id, { completed: true });
    expect(todoDB.findById(todo.id, owner.id)?.completed).toBe(false);
    subtaskDB.delete(first.id, owner.id);
    const third = subtaskDB.create(todo.id, owner.id, { title: 'Third' })!;
    expect([second.position, third.position]).toEqual([1, 2]);
    todoDB.update(todo.id, owner.id, { completed: true });
    expect(subtaskDB.findByTodoId(todo.id, owner.id)).toMatchObject([
      { id: second.id, completed: true, position: 1 },
      { id: third.id, completed: false, position: 2 },
    ]);
    todoDB.delete(todo.id, owner.id);
    expect(subtaskDB.findByTodoId(todo.id, owner.id)).toEqual([]);
  });
});
