import { describe, expect, it } from 'vitest';
import type { Todo } from '@/lib/db';
import { calculateProgress, sectionTodos, validateDraft } from '@/lib/todoPresentation';

const todo = (fields: Partial<Todo> = {}): Todo => ({
  id: 1, user_id: 1, title: 'Task', completed: false, due_date: null,
  priority: 'medium', is_recurring: false, recurrence_pattern: null,
  reminder_minutes: null, last_notification_sent: null,
  created_at: '2026-11-17T10:00:00+08:00', updated_at: null, ...fields,
});

describe('feature presentation', () => {
  it('calculates independent checklist progress, including zero and rounded percentages', () => {
    expect(calculateProgress([])).toEqual({ completed: 0, total: 0, percent: 0 });
    expect(calculateProgress([{ completed: true }, { completed: false }, { completed: false }]))
      .toEqual({ completed: 1, total: 3, percent: 33 });
  });

  it('sections and sorts tasks without changing the source array', () => {
    const tasks = [
      todo({ id: 1 }),
      todo({ id: 2, priority: 'high' }),
      todo({ id: 3, due_date: '2026-11-17T11:00:00+08:00' }),
      todo({ id: 4, completed: true }),
    ];
    const sections = sectionTodos(tasks, new Date('2026-11-17T12:00:00+08:00'));
    expect(sections.Overdue.map(t => t.id)).toEqual([3]);
    expect(sections.Pending.map(t => t.id)).toEqual([2, 1]);
    expect(sections.Completed.map(t => t.id)).toEqual([4]);
    expect(tasks.map(t => t.id)).toEqual([1, 2, 3, 4]);
  });

  it('validates recurrence, reminders and Singapore due-date boundaries', () => {
    const now = new Date('2026-11-17T12:00:00+08:00');
    expect(validateDraft({ title: ' ', due_date: null }, now)).toMatch(/Title/);
    expect(validateDraft({ title: 'Task', is_recurring: true, due_date: null }, now)).toMatch(/Recurring/);
    expect(validateDraft({ title: 'Task', reminder_minutes: 15 }, now)).toMatch(/Reminder/);
    expect(validateDraft({ title: 'Task', due_date: '2026-11-17T12:00:59' }, now)).toMatch(/1 minute/);
    expect(validateDraft({ title: 'Task', due_date: '2026-11-17T12:01' }, now)).toBeNull();
    expect(validateDraft({ title: 'Task', due_date: 'invalid' }, now)).toMatch(/valid/);
    expect(validateDraft({ title: 'Renamed', due_date: '2026-11-17T10:00+08:00' }, now, '2026-11-17T10:00+08:00')).toBeNull();
  });
});
