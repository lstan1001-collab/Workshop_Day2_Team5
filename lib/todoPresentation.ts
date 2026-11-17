import type { CreateTodoInput, Subtask, Todo } from '@/lib/db';
import { getSingaporeNow, parseSingaporeDate } from '@/lib/timezone';

const priorityOrder = { high: 0, medium: 1, low: 2 };

export function calculateProgress(subtasks: Pick<Subtask, 'completed'>[]) {
  const total = subtasks.length;
  const completed = subtasks.filter(subtask => subtask.completed).length;
  return { completed, total, percent: total ? Math.round(completed / total * 100) : 0 };
}

export function sectionTodos(todos: Todo[], now = getSingaporeNow()) {
  const sort = (items: Todo[]) => [...items].sort((a, b) =>
    priorityOrder[a.priority] - priorityOrder[b.priority] ||
    (a.due_date ? parseSingaporeDate(a.due_date)?.getTime() ?? Infinity : Infinity) -
      (b.due_date ? parseSingaporeDate(b.due_date)?.getTime() ?? Infinity : Infinity) ||
    b.created_at.localeCompare(a.created_at));
  const overdue = (todo: Todo) =>
    todo.due_date !== null && (parseSingaporeDate(todo.due_date)?.getTime() ?? Infinity) < now.getTime();
  return {
    Overdue: sort(todos.filter(todo => !todo.completed && overdue(todo))),
    Pending: sort(todos.filter(todo => !todo.completed && !overdue(todo))),
    Completed: todos.filter(todo => todo.completed).sort((a, b) =>
      (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at)),
  };
}

export function validateDraft(
  input: CreateTodoInput,
  now = getSingaporeNow(),
  previousDueDate?: string | null,
): string | null {
  if (!input.title.trim()) return 'Title is required';
  if (input.is_recurring && (!input.due_date || !input.recurrence_pattern)) {
    return 'Recurring todos require a due date and recurrence pattern';
  }
  if (input.reminder_minutes != null && !input.due_date) return 'Reminders require a due date';
  if (input.due_date) {
    const due = parseSingaporeDate(input.due_date);
    if (!due) return 'Enter a valid due date';
    const previous = previousDueDate ? parseSingaporeDate(previousDueDate) : null;
    if (due.getTime() !== previous?.getTime() && due.getTime() < now.getTime() + 60_000) {
      return 'Due date must be at least 1 minute in the future';
    }
  }
  return null;
}
