import { z } from 'zod';
import { ApiError } from '@/lib/api';
import type { Todo, TodoExport, TodoImportItem } from '@/lib/db';
import { prioritySchema, recurrencePatternSchema, reminderMinutesSchema } from '@/lib/todoValidation';
import { getSingaporeNow, parseSingaporeDate, toSingaporeISO } from '@/lib/timezone';

const dateSchema = z.string().transform((value, context) => {
  const date = parseSingaporeDate(value);
  if (!date) {
    context.addIssue({ code: 'custom', message: 'Invalid timestamp' });
    return z.NEVER;
  }
  return toSingaporeISO(date);
});
const createdAtSchema = z.string().refine((value) => {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return parseSingaporeDate(iso) !== null;
}, 'Invalid creation timestamp');
const itemSchema = z.strictObject({
  title: z.string().trim().min(1),
  completed: z.boolean(),
  due_date: dateSchema.nullable(),
  priority: prioritySchema,
  is_recurring: z.boolean(),
  recurrence_pattern: recurrencePatternSchema.nullable(),
  reminder_minutes: reminderMinutesSchema.nullable(),
  created_at: createdAtSchema,
  subtasks: z.array(z.strictObject({
    title: z.string().trim().min(1),
    completed: z.boolean(),
    position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })),
  tags: z.array(z.strictObject({
    name: z.string().trim().min(1),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
  })),
}).refine((item) => !item.is_recurring || Boolean(item.due_date && item.recurrence_pattern))
  .refine((item) => item.reminder_minutes == null || item.due_date !== null);
const importSchema = z.strictObject({
  version: z.literal(1),
  exported_at: dateSchema,
  todos: z.array(itemSchema),
});

export function validateImport(value: unknown): TodoExport {
  const parsed = importSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError('Failed to import todos. Please check the file format.');
  }
  return parsed.data;
}

export function toExportItem(todo: Todo): TodoImportItem {
  return {
    title: todo.title,
    completed: todo.completed,
    due_date: todo.due_date,
    priority: todo.priority,
    is_recurring: todo.is_recurring,
    recurrence_pattern: todo.recurrence_pattern,
    reminder_minutes: todo.reminder_minutes,
    created_at: todo.created_at,
    subtasks: (todo.subtasks ?? []).map(({ title, completed, position }) => ({ title, completed, position })),
    tags: (todo.tags ?? []).map(({ name, color }) => ({ name, color })),
  };
}

export function toExport(todos: Todo[], now = getSingaporeNow()): TodoExport {
  return { version: 1, exported_at: toSingaporeISO(now), todos: todos.map(toExportItem) };
}

function csvCell(value: string | number | boolean | null): string {
  const text = value == null ? '' : String(value);
  // Spreadsheet applications can execute formulas even inside quoted CSV cells.
  const safe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(todos: Todo[]): string {
  const header = 'ID,Title,Completed,Due Date,Priority,Recurring,Pattern,Reminder';
  return [header, ...todos.map((todo) => [
    todo.id, todo.title, todo.completed, todo.due_date, todo.priority,
    todo.is_recurring, todo.recurrence_pattern, todo.reminder_minutes,
  ].map(csvCell).join(','))].join('\r\n') + '\r\n';
}
