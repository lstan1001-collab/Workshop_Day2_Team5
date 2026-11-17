import { describe, expect, it } from 'vitest';
import { validateCreateTodo, validateTodoId, validateUpdateTodo } from '@/lib/todoValidation';
import { parseSingaporeDate } from '@/lib/timezone';
import type { Todo } from '@/lib/db';

const now = new Date('2026-11-17T16:00:00+08:00');
const existing: Todo = {
  id: 1, user_id: 1, title: 'Overdue', priority: 'high', completed: false,
  due_date: '2026-11-16T08:00:00.000+08:00', is_recurring: false,
  recurrence_pattern: null, reminder_minutes: null, last_notification_sent: null,
  created_at: '2026-11-01T00:00:00Z', updated_at: null,
};

describe('todo input validation', () => {
  it('trims titles and defaults only new todo priorities', () => {
    expect(validateCreateTodo({ title: '  Write report ' }, now))
      .toEqual({ title: 'Write report', priority: 'medium' });
    expect(validateUpdateTodo({ completed: true }, existing, now)).toEqual({ completed: true });
    expect(() => validateUpdateTodo({ priority: null }, existing, now)).toThrow();
    expect(() => validateUpdateTodo({ user_id: 2 }, existing, now)).toThrow();
    expect(() => validateCreateTodo({ title: ' ' }, now)).toThrow('Title is required');
    expect(() => validateCreateTodo({ title: 12 }, now)).toThrow();
  });

  it('checks the exact one-minute boundary in Singapore regardless of server timezone', () => {
    expect(validateCreateTodo({ title: 'Boundary', due_date: '2026-11-17T16:01' }, now).due_date)
      .toBe('2026-11-17T16:01:00.000+08:00');
    expect(() => validateCreateTodo({ title: 'Early', due_date: '2026-11-17T16:00:59.999' }, now)).toThrow('1 minute');
    expect(validateCreateTodo({ title: 'UTC', due_date: '2026-11-17T08:01:00Z' }, now).due_date)
      .toBe('2026-11-17T16:01:00.000+08:00');
    for (const date of ['garbage', '', '2026-02-29T10:00', '2026-11-17T24:00', '2026-04-31T12:00']) {
      expect(() => validateCreateTodo({ title: 'Bad date', due_date: date }, now)).toThrow();
    }
    expect(parseSingaporeDate('2028-02-29T10:00')).not.toBeNull();
  });

  it('allows overdue completion/title edits and unchanged due dates', () => {
    expect(validateUpdateTodo({ title: 'Updated' }, existing, now)).toEqual({ title: 'Updated' });
    expect(validateUpdateTodo({ due_date: existing.due_date }, existing, now).due_date).toBe(existing.due_date);
    expect(() => validateUpdateTodo({ due_date: '2026-11-15T10:00' }, existing, now)).toThrow('1 minute');
    expect(validateUpdateTodo({ due_date: null }, existing, now)).toEqual({ due_date: null });
  });

  it('rejects invalid priorities, booleans, metadata dependencies, and IDs', () => {
    for (const priority of ['urgent', 'HIGH', '', 1, false]) {
      expect(() => validateCreateTodo({ title: 'Invalid', priority }, now)).toThrow();
    }
    expect(() => validateUpdateTodo({ completed: 'false' }, existing, now)).toThrow();
    expect(() => validateCreateTodo({ title: 'Repeat', is_recurring: true }, now)).toThrow('Recurring');
    expect(() => validateCreateTodo({ title: 'Reminder', reminder_minutes: 15 }, now)).toThrow('Reminders');
    for (const id of ['0', '-1', '1.2', '1x', '9007199254740992']) {
      expect(() => validateTodoId(id)).toThrow('Invalid todo ID');
    }
  });
});
