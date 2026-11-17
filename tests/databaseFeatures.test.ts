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

const {
  createDatabase,
  db,
  holidayDB,
  subtaskDB,
  tagDB,
  templateDB,
  todoDB,
  userDB,
} = await import('@/lib/db');
const owner = userDB.create('database-owner');
const other = userDB.create('database-other');

beforeEach(() => {
  db.prepare('DELETE FROM todos').run();
  db.prepare('DELETE FROM tags').run();
  db.prepare('DELETE FROM templates').run();
  db.prepare('DELETE FROM holidays').run();
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

describe('tag persistence', () => {
  it('scopes names by user, trims names, and defaults the color', () => {
    const tag = tagDB.create(owner.id, { name: '  Work  ' });
    const sameNameForOtherUser = tagDB.create(other.id, { name: 'Work', color: '#123456' });

    expect(tag).toMatchObject({ user_id: owner.id, name: 'Work', color: '#3B82F6' });
    expect(sameNameForOtherUser).toMatchObject({
      user_id: other.id, name: 'Work', color: '#123456',
    });
    expect(tagDB.findAllByUser(owner.id)).toEqual([tag]);
    expect(tagDB.findAllByUser(other.id)).toEqual([sameNameForOtherUser]);
    expect(() => tagDB.create(owner.id, { name: 'Work' })).toThrow();
    expect(() => tagDB.create(owner.id, { name: '  ' })).toThrow('Tag name is required');
    expect(() => tagDB.create(owner.id, { name: 'Bad color', color: 'red' }))
      .toThrow('Color must be a valid hex code');
  });

  it('updates and deletes only tags owned by the user', () => {
    const tag = tagDB.create(owner.id, { name: 'Work' });

    expect(tagDB.update(tag.id, other.id, { name: 'Private' })).toBeNull();
    expect(tagDB.delete(tag.id, other.id)).toBe(false);
    expect(tagDB.update(tag.id, owner.id, { name: '  Project  ', color: '#AABBCC' }))
      .toMatchObject({ id: tag.id, user_id: owner.id, name: 'Project', color: '#AABBCC' });
    expect(() => tagDB.update(tag.id, owner.id, { color: 'blue' }))
      .toThrow('Color must be a valid hex code');
    expect(tagDB.delete(tag.id, owner.id)).toBe(true);
    expect(tagDB.delete(tag.id, owner.id)).toBe(false);
  });

  it('attaches and detaches idempotently and cascades tag deletion', () => {
    const todo = todoDB.create({ user_id: owner.id, title: 'Tagged todo' });
    const first = tagDB.create(owner.id, { name: 'First' });
    const second = tagDB.create(owner.id, { name: 'Second' });
    const foreign = tagDB.create(other.id, { name: 'Foreign' });

    expect(tagDB.attachToTodo(todo.id, first.id, owner.id)).toBe(true);
    expect(tagDB.attachToTodo(todo.id, first.id, owner.id)).toBe(false);
    expect(tagDB.attachToTodo(todo.id, second.id, owner.id)).toBe(true);
    expect(tagDB.attachToTodo(todo.id, foreign.id, owner.id)).toBe(false);
    expect(tagDB.attachToTodo(todo.id, first.id, other.id)).toBe(false);
    expect(tagDB.findByTodoId(todo.id, other.id)).toEqual([]);
    expect(tagDB.findByTodoId(todo.id, owner.id).map(({ id }) => id))
      .toEqual([first.id, second.id]);

    expect(tagDB.detachFromTodo(todo.id, first.id, other.id)).toBe(false);
    expect(tagDB.detachFromTodo(todo.id, first.id, owner.id)).toBe(true);
    expect(tagDB.detachFromTodo(todo.id, first.id, owner.id)).toBe(false);
    expect(tagDB.delete(second.id, owner.id)).toBe(true);
    expect(db.prepare('SELECT tag_id FROM todo_tags WHERE todo_id = ?').all(todo.id))
      .toEqual([]);
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

describe('template persistence', () => {
  it('scopes templates by owner and creates a snapshot todo with ordered subtasks', () => {
    const template = templateDB.create(owner.id, {
      name: '  Weekly Review  ',
      title_template: '  Review the week  ',
      priority: 'high',
      is_recurring: true,
      recurrence_pattern: 'weekly',
      reminder_minutes: 60,
      due_date_offset_minutes: 1440,
      subtasks: [
        { title: 'Collect notes', position: 0 },
        { title: 'Plan next week', position: 1 },
      ],
    });

    expect(template).toMatchObject({
      name: 'Weekly Review',
      title_template: 'Review the week',
      priority: 'high',
      is_recurring: true,
      recurrence_pattern: 'weekly',
      reminder_minutes: 60,
      due_date_offset_minutes: 1440,
      subtasks_json: JSON.stringify([
        { title: 'Collect notes', position: 0 },
        { title: 'Plan next week', position: 1 },
      ]),
    });
    expect(templateDB.findById(template.id, other.id)).toBeNull();
    expect(templateDB.findAllByUser(owner.id)).toEqual([template]);

    const todo = templateDB.createTodoFromTemplate(
      template.id,
      owner.id,
      '2026-12-09T10:00:00+08:00',
    );
    expect(todo).toMatchObject({
      title: 'Review the week',
      due_date: '2026-12-09T10:00:00+08:00',
      priority: 'high',
      is_recurring: true,
      recurrence_pattern: 'weekly',
      reminder_minutes: 60,
      subtasks: [
        { title: 'Collect notes', position: 0, completed: false },
        { title: 'Plan next week', position: 1, completed: false },
      ],
      tags: [],
    });
    expect(templateDB.createTodoFromTemplate(template.id, other.id, null)).toBeNull();

    expect(templateDB.delete(template.id, owner.id)).toBe(true);
    expect(todoDB.findById(todo!.id, owner.id)).not.toBeNull();
  });

  it('rolls back todo creation if recreating a template subtask fails', () => {
    const template = templateDB.create(owner.id, {
      name: 'Broken checklist',
      title_template: 'Should roll back',
      subtasks: [{ title: 'Fails', position: 0 }],
    });
    db.exec(`CREATE TEMP TRIGGER fail_template_subtask
      BEFORE INSERT ON subtasks
      BEGIN SELECT RAISE(ABORT, 'subtask insert failed'); END;`);
    try {
      expect(() => templateDB.createTodoFromTemplate(template.id, owner.id, null))
        .toThrow('subtask insert failed');
      expect(todoDB.findAllByUser(owner.id)).toEqual([]);
    } finally {
      db.exec('DROP TRIGGER fail_template_subtask');
    }
  });
});

describe('export/import persistence', () => {
  it('exports nested relations and imports new IDs while reusing tags case-insensitively', () => {
    const existingTag = tagDB.create(owner.id, { name: 'Work', color: '#123456' });
    const source = todoDB.create({
      user_id: owner.id,
      title: 'Exported source',
      priority: 'high',
      is_recurring: true,
      recurrence_pattern: 'monthly',
      due_date: '2026-12-31T09:00:00+08:00',
      reminder_minutes: 60,
      tag_ids: [existingTag.id],
    });
    subtaskDB.create(source.id, owner.id, { title: 'First step' });

    const exported = todoDB.findAllWithRelations(owner.id);
    expect(exported[0]).toMatchObject({
      id: source.id,
      subtasks: [{ title: 'First step' }],
      tags: [{ id: existingTag.id, name: 'Work' }],
    });

    const result = todoDB.importAll(owner.id, [{
      title: 'Imported source',
      completed: false,
      due_date: source.due_date,
      priority: source.priority,
      is_recurring: source.is_recurring,
      recurrence_pattern: source.recurrence_pattern,
      reminder_minutes: source.reminder_minutes,
      created_at: source.created_at,
      subtasks: [{ title: 'Imported step', completed: true, position: 7 }],
      tags: [{ name: 'work', color: '#EF4444' }, { name: 'WORK', color: '#000000' }],
    }]);

    expect(result).toEqual({ imported: 1, tagsCreated: 0, tagsReused: 2 });
    const todos = todoDB.findAllWithRelations(owner.id);
    const imported = todos.find((todo) => todo.title === 'Imported source');
    expect(imported?.id).not.toBe(source.id);
    expect(imported).toMatchObject({
      completed: false,
      priority: 'high',
      recurrence_pattern: 'monthly',
      reminder_minutes: 60,
      last_notification_sent: null,
      subtasks: [{ title: 'Imported step', completed: true, position: 0 }],
      tags: [{ id: existingTag.id, name: 'Work', color: '#123456' }],
    });
  });

  it('rolls back all import rows if a child insert fails', () => {
    const item = {
      title: 'Atomic import',
      completed: false,
      due_date: null,
      priority: 'medium' as const,
      is_recurring: false,
      recurrence_pattern: null,
      reminder_minutes: null,
      created_at: '2026-12-08T10:00:00+08:00',
      subtasks: [{ title: 'Failing child', completed: false, position: 0 }],
      tags: [{ name: 'New import tag', color: '#123456' }],
    };
    db.exec(`CREATE TEMP TRIGGER fail_import_subtask
      BEFORE INSERT ON subtasks
      BEGIN SELECT RAISE(ABORT, 'import child failed'); END;`);
    try {
      expect(() => todoDB.importAll(owner.id, [item])).toThrow('import child failed');
      expect(todoDB.findAllByUser(owner.id)).toEqual([]);
      expect(tagDB.findAllByUser(owner.id)).toEqual([]);
    } finally {
      db.exec('DROP TRIGGER fail_import_subtask');
    }
  });
});

describe('holiday persistence', () => {
  it('upserts dates and returns holidays on the visible six-week calendar grid', () => {
    holidayDB.upsert('2025-02-28', 'Before March');
    holidayDB.upsert('2025-04-04', 'After March');
    holidayDB.upsert('2025-04-04', 'Updated holiday');
    holidayDB.upsert('2025-04-06', 'Outside grid');

    expect(holidayDB.findAll()).toEqual([
      { id: expect.any(Number), date: '2025-02-28', name: 'Before March' },
      { id: expect.any(Number), date: '2025-04-04', name: 'Updated holiday' },
      { id: expect.any(Number), date: '2025-04-06', name: 'Outside grid' },
    ]);
    expect(holidayDB.findByMonth(2025, 3).map(({ date }) => date))
      .toEqual(['2025-02-28', '2025-04-04']);
    expect(() => holidayDB.findByMonth(2025, 13)).toThrow('A valid year and month are required');
  });
});
