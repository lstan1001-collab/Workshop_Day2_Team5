import Database from 'better-sqlite3';
import path from 'node:path';

export type Priority = 'high' | 'medium' | 'low';
export type RecurrencePattern = 'daily' | 'weekly' | 'monthly' | 'yearly';

export const PRIORITY_VALUES: Priority[] = ['high', 'medium', 'low'];
export const PRIORITY_ORDER: Record<Priority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface User {
  id: number;
  username: string;
  created_at: string;
}

export interface Authenticator {
  id: number;
  user_id: number;
  credential_id: string;
  credential_public_key: Buffer;
  counter: number;
  created_at: string;
}

export interface Tag {
  id: number;
  user_id: number;
  name: string;
  color: string;
  created_at: string;
}

export interface CreateTagInput {
  name: string;
  color?: string;
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
}

export interface Subtask {
  id: number;
  todo_id: number;
  title: string;
  completed: boolean;
  position: number;
  created_at: string;
}

export interface CreateSubtaskInput {
  title: string;
}

export interface UpdateSubtaskInput {
  title?: string;
  completed?: boolean;
}

export interface Todo {
  id: number;
  user_id: number;
  title: string;
  completed: boolean;
  due_date: string | null;
  priority: Priority;
  is_recurring: boolean;
  recurrence_pattern: RecurrencePattern | null;
  reminder_minutes: number | null;
  last_notification_sent: string | null;
  created_at: string;
  updated_at: string | null;
  subtasks?: Subtask[];
  tags?: Tag[];
}

export interface CreateTodoInput {
  title: string;
  due_date?: string | null;
  priority?: Priority;
  is_recurring?: boolean;
  recurrence_pattern?: RecurrencePattern | null;
  reminder_minutes?: number | null;
  tag_ids?: number[];
}

export interface UpdateTodoInput extends Partial<CreateTodoInput> {
  completed?: boolean;
}

type TodoRecord = Omit<Todo, 'completed' | 'is_recurring' | 'subtasks' | 'tags'> & {
  completed: number;
  is_recurring: number;
};

type SubtaskRecord = Omit<Subtask, 'completed'> & { completed: number };
type SqliteDatabase = InstanceType<typeof Database>;

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS authenticators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT UNIQUE NOT NULL,
    credential_public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    is_recurring INTEGER NOT NULL DEFAULT 0,
    recurrence_pattern TEXT,
    reminder_minutes INTEGER,
    last_notification_sent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS subtasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3B82F6',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
  );
  CREATE TABLE IF NOT EXISTS todo_tags (
    todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (todo_id, tag_id)
  );
`;

function tableColumns(database: SqliteDatabase, table: string): string[] {
  const rows = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.map(({ name }) => name);
}

function addTodoColumnIfMissing(
  database: SqliteDatabase,
  column: string,
  definition: string,
): void {
  if (tableColumns(database, 'todos').includes(column)) return;

  try {
    database.exec(`ALTER TABLE todos ADD COLUMN ${definition}`);
  } catch (error) {
    if (!tableColumns(database, 'todos').includes(column)) throw error;
  }
}

function initializeSchema(database: SqliteDatabase): void {
  database.pragma('foreign_keys = ON');
  database.exec(schema);

  const todoColumns = tableColumns(database, 'todos');
  for (const requiredColumn of ['id', 'user_id', 'title']) {
    if (!todoColumns.includes(requiredColumn)) {
      throw new Error(`Existing todos table is missing required column "${requiredColumn}"`);
    }
  }

  addTodoColumnIfMissing(database, 'completed', 'completed INTEGER NOT NULL DEFAULT 0');
  addTodoColumnIfMissing(database, 'due_date', 'due_date TEXT');
  addTodoColumnIfMissing(
    database,
    'priority',
    "priority TEXT NOT NULL DEFAULT 'medium'",
  );
  addTodoColumnIfMissing(
    database,
    'is_recurring',
    'is_recurring INTEGER NOT NULL DEFAULT 0',
  );
  addTodoColumnIfMissing(database, 'recurrence_pattern', 'recurrence_pattern TEXT');
  addTodoColumnIfMissing(database, 'reminder_minutes', 'reminder_minutes INTEGER');
  addTodoColumnIfMissing(
    database,
    'last_notification_sent',
    'last_notification_sent TEXT',
  );
  addTodoColumnIfMissing(
    database,
    'created_at',
    "created_at TEXT NOT NULL DEFAULT ''",
  );
  addTodoColumnIfMissing(database, 'updated_at', 'updated_at TEXT');
  database.exec(
    "UPDATE todos SET created_at = datetime('now') WHERE created_at = ''",
  );
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_authenticators_user_id ON authenticators(user_id);
    CREATE INDEX IF NOT EXISTS idx_todos_user_id ON todos(user_id);
    CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date);
    CREATE INDEX IF NOT EXISTS idx_subtasks_todo_id ON subtasks(todo_id);
    CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id);
    CREATE INDEX IF NOT EXISTS idx_todo_tags_tag_id ON todo_tags(tag_id);
  `);
}

export function createDatabase(filePath = path.join(process.cwd(), 'todos.db')): SqliteDatabase {
  const database = new Database(filePath);
  initializeSchema(database);
  return database;
}

const globalForDatabase = globalThis as typeof globalThis & {
  todoDatabase?: SqliteDatabase;
};

export const db =
  globalForDatabase.todoDatabase ??
  (globalForDatabase.todoDatabase = createDatabase());

function mapTodos(records: TodoRecord[], database: SqliteDatabase): Todo[] {
  const subtasksByTodo = new Map<number, Subtask[]>();
  const tagsByTodo = new Map<number, Tag[]>();

  for (let offset = 0; offset < records.length; offset += 400) {
    const batch = records.slice(offset, offset + 400);
    const placeholders = batch.map(() => '?').join(', ');
    const ids = batch.map(({ id }) => id);
    const subtasks = database
      .prepare(
        `SELECT id, todo_id, title, completed, position, created_at
         FROM subtasks WHERE todo_id IN (${placeholders})
         ORDER BY position ASC, id ASC`,
      )
      .all(...ids) as SubtaskRecord[];
    const tags = database
      .prepare(
        `SELECT todo_tags.todo_id, tags.id, tags.user_id, tags.name,
                tags.color, tags.created_at
         FROM tags
         INNER JOIN todo_tags ON todo_tags.tag_id = tags.id
         WHERE todo_tags.todo_id IN (${placeholders})
         ORDER BY tags.name COLLATE NOCASE ASC, tags.id ASC`,
      )
      .all(...ids) as Array<Tag & { todo_id: number }>;

    for (const subtask of subtasks) {
      const todoSubtasks = subtasksByTodo.get(subtask.todo_id) ?? [];
      todoSubtasks.push({ ...subtask, completed: Boolean(subtask.completed) });
      subtasksByTodo.set(subtask.todo_id, todoSubtasks);
    }
    for (const tag of tags) {
      const todoTags = tagsByTodo.get(tag.todo_id) ?? [];
      todoTags.push({
        id: tag.id,
        user_id: tag.user_id,
        name: tag.name,
        color: tag.color,
        created_at: tag.created_at,
      });
      tagsByTodo.set(tag.todo_id, todoTags);
    }
  }

  return records.map((record) => ({
    ...record,
    completed: Boolean(record.completed),
    is_recurring: Boolean(record.is_recurring),
    recurrence_pattern: record.recurrence_pattern as RecurrencePattern | null,
    priority: record.priority as Priority,
    subtasks: subtasksByTodo.get(record.id) ?? [],
    tags: tagsByTodo.get(record.id) ?? [],
  }));
}

function findTodoById(
  database: SqliteDatabase,
  id: number,
  userId: number,
): Todo | null {
  const record = database
    .prepare('SELECT * FROM todos WHERE id = ? AND user_id = ?')
    .get(id, userId) as TodoRecord | undefined;
  return record ? mapTodos([record], database)[0] : null;
}

function findSubtaskById(
  database: SqliteDatabase,
  id: number,
  userId: number,
): Subtask | null {
  const record = database
    .prepare(
      `SELECT subtasks.id, subtasks.todo_id, subtasks.title, subtasks.completed,
              subtasks.position, subtasks.created_at
       FROM subtasks
       INNER JOIN todos ON todos.id = subtasks.todo_id
       WHERE subtasks.id = ? AND todos.user_id = ?`,
    )
    .get(id, userId) as SubtaskRecord | undefined;
  return record ? { ...record, completed: Boolean(record.completed) } : null;
}

function normalizePriority(value: Priority | undefined): Priority {
  return value ?? 'medium';
}

function attachTags(
  database: SqliteDatabase,
  todoId: number,
  userId: number,
  tagIds: number[],
): void {
  const insert = database.prepare(
    `INSERT INTO todo_tags (todo_id, tag_id)
     SELECT ?, id FROM tags WHERE id = ? AND user_id = ?`,
  );

  for (const tagId of tagIds) {
    if (insert.run(todoId, tagId, userId).changes !== 1) {
      throw new Error(`Tag ${tagId} does not belong to user ${userId}`);
    }
  }
}

export const userDB = {
  findById(id: number): User | null {
    return (
      (db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id) as
        | User
        | undefined) ?? null
    );
  },

  findByUsername(username: string): User | null {
    return (
      (db
        .prepare('SELECT id, username, created_at FROM users WHERE username = ?')
        .get(username) as User | undefined) ?? null
    );
  },

  create(username: string): User {
    const result = db
      .prepare('INSERT INTO users (username) VALUES (?)')
      .run(username);
    const user = userDB.findById(Number(result.lastInsertRowid));
    if (!user) throw new Error('Created user could not be loaded');
    return user;
  },
};

export const authenticatorDB = {
  findByCredentialId(credentialId: string): Authenticator | null {
    return (
      (db
        .prepare('SELECT * FROM authenticators WHERE credential_id = ?')
        .get(credentialId) as Authenticator | undefined) ?? null
    );
  },

  findByUserId(userId: number): Authenticator[] {
    return db
      .prepare('SELECT * FROM authenticators WHERE user_id = ? ORDER BY id ASC')
      .all(userId) as Authenticator[];
  },

  create(
    data: Omit<Authenticator, 'id' | 'created_at'> & { counter?: number },
  ): Authenticator {
    const result = db
      .prepare(
        `INSERT INTO authenticators
          (user_id, credential_id, credential_public_key, counter)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        data.user_id,
        data.credential_id,
        data.credential_public_key,
        data.counter ?? 0,
      );
    return db
      .prepare('SELECT * FROM authenticators WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as Authenticator;
  },

  updateCounter(id: number, counter: number): Authenticator | null {
    const result = db
      .prepare('UPDATE authenticators SET counter = ? WHERE id = ?')
      .run(counter, id);
    if (result.changes === 0) return null;
    return db
      .prepare('SELECT * FROM authenticators WHERE id = ?')
      .get(id) as Authenticator;
  },
};

function validateTagInput(input: CreateTagInput | UpdateTagInput): void {
  if (input.name !== undefined && !input.name.trim()) {
    throw new RangeError('Tag name is required');
  }
  if (input.color !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(input.color)) {
    throw new RangeError('Color must be a valid hex code');
  }
}

export const tagDB = {
  findAllByUser(userId: number): Tag[] {
    return db
      .prepare(
        `SELECT id, user_id, name, color, created_at
         FROM tags WHERE user_id = ?
         ORDER BY name COLLATE NOCASE ASC, id ASC`,
      )
      .all(userId) as Tag[];
  },

  findById(id: number, userId: number): Tag | null {
    return (
      (db
        .prepare(
          `SELECT id, user_id, name, color, created_at
           FROM tags WHERE id = ? AND user_id = ?`,
        )
        .get(id, userId) as Tag | undefined) ?? null
    );
  },

  create(userId: number, input: CreateTagInput): Tag {
    validateTagInput(input);
    const result = db
      .prepare('INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)')
      .run(userId, input.name.trim(), input.color ?? '#3B82F6');
    const tag = tagDB.findById(Number(result.lastInsertRowid), userId);
    if (!tag) throw new Error('Created tag could not be loaded');
    return tag;
  },

  update(id: number, userId: number, input: UpdateTagInput): Tag | null {
    validateTagInput(input);
    const existing = tagDB.findById(id, userId);
    if (!existing) return null;

    const name = input.name === undefined ? existing.name : input.name.trim();
    const color = input.color ?? existing.color;
    db.prepare(
      'UPDATE tags SET name = ?, color = ? WHERE id = ? AND user_id = ?',
    ).run(name, color, id, userId);
    return tagDB.findById(id, userId);
  },

  delete(id: number, userId: number): boolean {
    return db
      .prepare('DELETE FROM tags WHERE id = ? AND user_id = ?')
      .run(id, userId).changes > 0;
  },

  attachToTodo(todoId: number, tagId: number, userId: number): boolean {
    return db.prepare(
      `INSERT INTO todo_tags (todo_id, tag_id)
       SELECT todos.id, tags.id
       FROM todos
       INNER JOIN tags ON tags.id = ?
       WHERE todos.id = ? AND todos.user_id = ? AND tags.user_id = ?
       ON CONFLICT(todo_id, tag_id) DO NOTHING`,
    ).run(tagId, todoId, userId, userId).changes > 0;
  },

  detachFromTodo(todoId: number, tagId: number, userId: number): boolean {
    return db.prepare(
      `DELETE FROM todo_tags
       WHERE todo_id = ? AND tag_id = ?
         AND EXISTS (
           SELECT 1 FROM todos
           WHERE todos.id = todo_tags.todo_id AND todos.user_id = ?
         )
         AND EXISTS (
           SELECT 1 FROM tags
           WHERE tags.id = todo_tags.tag_id AND tags.user_id = ?
         )`,
    ).run(todoId, tagId, userId, userId).changes > 0;
  },

  findByTodoId(todoId: number, userId: number): Tag[] {
    return db.prepare(
      `SELECT tags.id, tags.user_id, tags.name, tags.color, tags.created_at
       FROM tags
       INNER JOIN todo_tags ON todo_tags.tag_id = tags.id
       INNER JOIN todos ON todos.id = todo_tags.todo_id
       WHERE todo_tags.todo_id = ? AND todos.user_id = ? AND tags.user_id = ?
       ORDER BY tags.name COLLATE NOCASE ASC, tags.id ASC`,
    ).all(todoId, userId, userId) as Tag[];
  },
};

export const todoDB = {
  findAllByUser(userId: number): Todo[] {
    const records = db
      .prepare(
        `SELECT * FROM todos
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(userId) as TodoRecord[];
    return mapTodos(records, db);
  },

  findById(id: number, userId: number): Todo | null {
    return findTodoById(db, id, userId);
  },

  findDueReminders(userId: number, now: string): Todo[] {
    const records = db
      .prepare(
        `SELECT * FROM todos
         WHERE user_id = ?
           AND completed = 0
           AND due_date IS NOT NULL
           AND reminder_minutes IS NOT NULL
           AND last_notification_sent IS NULL
           AND unixepoch(due_date, 'subsec') - reminder_minutes * 60 <= unixepoch(?, 'subsec')
           AND unixepoch(due_date, 'subsec') >= unixepoch(?, 'subsec')
         ORDER BY unixepoch(due_date, 'subsec') ASC, id ASC`,
      )
      .all(userId, now, now) as TodoRecord[];
    return mapTodos(records, db);
  },

  create(data: CreateTodoInput & { user_id: number }): Todo {
    const createTodo = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO todos
            (user_id, title, due_date, priority, is_recurring,
             recurrence_pattern, reminder_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.user_id,
          data.title,
          data.due_date ?? null,
          normalizePriority(data.priority),
          data.is_recurring ? 1 : 0,
          data.recurrence_pattern ?? null,
          data.reminder_minutes ?? null,
        );
      const todoId = Number(result.lastInsertRowid);
      if (data.tag_ids?.length) {
        attachTags(db, todoId, data.user_id, data.tag_ids);
      }

      const todo = findTodoById(db, todoId, data.user_id);
      if (!todo) throw new Error('Created todo could not be loaded');
      return todo;
    });

    return createTodo();
  },

  update(id: number, userId: number, data: UpdateTodoInput): Todo | null {
    const updateTodo = db.transaction(() => {
      const existing = findTodoById(db, id, userId);
      if (!existing) return null;

      const columns: Array<[string, unknown]> = [];
      if (data.title !== undefined) columns.push(['title', data.title]);
      if (data.completed !== undefined) {
        columns.push(['completed', data.completed ? 1 : 0]);
      }
      if (data.due_date !== undefined) columns.push(['due_date', data.due_date]);
      if (data.priority !== undefined) columns.push(['priority', data.priority]);
      if (data.is_recurring !== undefined) {
        columns.push(['is_recurring', data.is_recurring ? 1 : 0]);
      }
      if (data.recurrence_pattern !== undefined) {
        columns.push(['recurrence_pattern', data.recurrence_pattern]);
      }
      if (data.reminder_minutes !== undefined) {
        columns.push(['reminder_minutes', data.reminder_minutes]);
      }
      const reminderSettingsChanged =
        (data.due_date !== undefined && data.due_date !== existing.due_date) ||
        (data.reminder_minutes !== undefined &&
          data.reminder_minutes !== existing.reminder_minutes);
      if (reminderSettingsChanged) {
        columns.push(['last_notification_sent', null]);
      }

      if (columns.length > 0) {
        const assignments = columns.map(([column]) => `${column} = ?`).join(', ');
        db.prepare(
          `UPDATE todos SET ${assignments}, updated_at = datetime('now')
           WHERE id = ? AND user_id = ?`,
        ).run(...columns.map(([, value]) => value), id, userId);
      }

      if (data.tag_ids !== undefined) {
        db.prepare('DELETE FROM todo_tags WHERE todo_id = ?').run(id);
        attachTags(db, id, userId, data.tag_ids);
        db.prepare("UPDATE todos SET updated_at = datetime('now') WHERE id = ? AND user_id = ?")
          .run(id, userId);
      }

      return findTodoById(db, id, userId);
    });

    return updateTodo();
  },

  completeAndCreateNext(
    id: number,
    userId: number,
    data: UpdateTodoInput,
    calculateNextDueDate: (dueDate: string, pattern: RecurrencePattern) => string,
  ): { todo: Todo | null; nextInstance: Todo | null } {
    const complete = db.transaction(() => {
      const existing = findTodoById(db, id, userId);
      if (!existing) return { todo: null, nextInstance: null };
      if (existing.completed) return { todo: existing, nextInstance: null };

      const updated = todoDB.update(id, userId, { ...data, completed: true });
      if (!updated) return { todo: null, nextInstance: null };
      if (
        !updated.is_recurring ||
        !updated.recurrence_pattern ||
        !updated.due_date
      ) {
        return { todo: updated, nextInstance: null };
      }

      const tagIds = db
        .prepare('SELECT tag_id FROM todo_tags WHERE todo_id = ? ORDER BY tag_id')
        .all(updated.id)
        .map((row) => (row as { tag_id: number }).tag_id);
      const nextInstance = todoDB.create({
        user_id: userId,
        title: updated.title,
        due_date: calculateNextDueDate(updated.due_date, updated.recurrence_pattern),
        priority: updated.priority,
        is_recurring: true,
        recurrence_pattern: updated.recurrence_pattern,
        reminder_minutes: updated.reminder_minutes,
        tag_ids: tagIds,
      });
      return { todo: updated, nextInstance };
    });

    return complete();
  },

  markReminderSent(id: number, userId: number, now: string): Todo | null {
    db.prepare(
      `UPDATE todos
       SET last_notification_sent = ?
       WHERE id = ? AND user_id = ? AND completed = 0
         AND due_date IS NOT NULL AND reminder_minutes IS NOT NULL
         AND last_notification_sent IS NULL
         AND unixepoch(due_date, 'subsec') - reminder_minutes * 60 <= unixepoch(?, 'subsec')
         AND unixepoch(due_date, 'subsec') >= unixepoch(?, 'subsec')`,
    ).run(now, id, userId, now, now);
    return findTodoById(db, id, userId);
  },

  delete(id: number, userId: number): boolean {
    return (
      db
        .prepare('DELETE FROM todos WHERE id = ? AND user_id = ?')
        .run(id, userId).changes > 0
    );
  },
};

export const subtaskDB = {
  findByTodoId(todoId: number, userId: number): Subtask[] {
    return (db
      .prepare(
        `SELECT subtasks.id, subtasks.todo_id, subtasks.title, subtasks.completed,
                subtasks.position, subtasks.created_at
         FROM subtasks
         INNER JOIN todos ON todos.id = subtasks.todo_id
         WHERE subtasks.todo_id = ? AND todos.user_id = ?
         ORDER BY subtasks.position ASC, subtasks.id ASC`,
      )
      .all(todoId, userId) as SubtaskRecord[]).map((record) => ({
      ...record,
      completed: Boolean(record.completed),
    }));
  },

  create(todoId: number, userId: number, input: CreateSubtaskInput): Subtask | null {
    const createSubtask = db.transaction(() => {
      const parent = db
        .prepare('SELECT id FROM todos WHERE id = ? AND user_id = ?')
        .get(todoId, userId);
      if (!parent) return null;

      const position = db
        .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM subtasks WHERE todo_id = ?')
        .get(todoId) as { position: number };
      const result = db
        .prepare('INSERT INTO subtasks (todo_id, title, position) VALUES (?, ?, ?)')
        .run(todoId, input.title, position.position);
      return findSubtaskById(db, Number(result.lastInsertRowid), userId);
    });
    return createSubtask();
  },

  update(id: number, userId: number, input: UpdateSubtaskInput): Subtask | null {
    const updateSubtask = db.transaction(() => {
      const existing = findSubtaskById(db, id, userId);
      if (!existing) return null;

      const columns: Array<[string, unknown]> = [];
      if (input.title !== undefined) columns.push(['title', input.title]);
      if (input.completed !== undefined) {
        columns.push(['completed', input.completed ? 1 : 0]);
      }
      if (columns.length > 0) {
        const assignments = columns.map(([column]) => `${column} = ?`).join(', ');
        db.prepare(
          `UPDATE subtasks SET ${assignments}
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM todos WHERE todos.id = subtasks.todo_id AND todos.user_id = ?
           )`,
        ).run(...columns.map(([, value]) => value), id, userId);
      }
      return findSubtaskById(db, id, userId);
    });
    return updateSubtask();
  },

  delete(id: number, userId: number): boolean {
    return db.prepare(
      `DELETE FROM subtasks
       WHERE id = ? AND EXISTS (
         SELECT 1 FROM todos WHERE todos.id = subtasks.todo_id AND todos.user_id = ?
       )`,
    ).run(id, userId).changes > 0;
  },
};
