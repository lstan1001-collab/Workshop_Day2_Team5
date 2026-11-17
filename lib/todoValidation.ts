import { z } from 'zod';
import type { CreateTodoInput, Priority, Todo, UpdateTodoInput } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { getSingaporeNow, parseSingaporeDate, toSingaporeISO } from '@/lib/timezone';

const prioritySchema = z.enum(['high', 'medium', 'low'], {
  error: "Priority must be 'high', 'medium', or 'low'.",
});
const dateSchema = z.string().transform((value, context) => {
  const date = parseSingaporeDate(value);
  if (!date) {
    context.addIssue({ code: 'custom', message: 'Invalid due date; use an ISO date and time' });
    return z.NEVER;
  }
  return toSingaporeISO(date);
}).nullable();
const fields = {
  title: z.string().trim().min(1, 'Title is required'),
  due_date: dateSchema.optional(),
  priority: prioritySchema.optional(),
  is_recurring: z.boolean().optional(),
  recurrence_pattern: z.enum(['daily', 'weekly', 'monthly', 'yearly']).nullable().optional(),
  reminder_minutes: z.union([
    z.literal(15), z.literal(30), z.literal(60), z.literal(120),
    z.literal(1440), z.literal(2880), z.literal(10080),
  ]).nullable().optional(),
  tag_ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .transform((ids) => [...new Set(ids)]).optional(),
};
const createSchema = z.strictObject({
  ...fields,
  priority: prioritySchema.nullish().transform((priority) => priority ?? 'medium'),
});
const updateSchema = z.strictObject({
  ...fields,
  title: fields.title.optional(),
  completed: z.boolean().optional(),
});

export function validatePriority(value: unknown): Priority {
  return prioritySchema.parse(value);
}

export function validateTodoId(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) throw new ApiError('Invalid todo ID');
  return id;
}

function validateRelationships(
  input: UpdateTodoInput,
  existing?: Todo,
  now = getSingaporeNow(),
): void {
  const state = { ...existing, ...input };
  if (state.is_recurring && (!state.due_date || !state.recurrence_pattern)) {
    throw new ApiError('Recurring todos require a due date and recurrence pattern');
  }
  if (state.reminder_minutes != null && !state.due_date) {
    throw new ApiError('Reminders require a due date');
  }
  if (input.due_date) {
    const due = parseSingaporeDate(input.due_date)!;
    const previous = existing?.due_date ? parseSingaporeDate(existing.due_date) : null;
    if (due.getTime() !== previous?.getTime() && due.getTime() < now.getTime() + 60_000) {
      throw new ApiError('Due date must be at least 1 minute in the future');
    }
  }
}

export function validateCreateTodo(value: unknown, now = getSingaporeNow()): CreateTodoInput {
  const input = createSchema.parse(value);
  validateRelationships(input, undefined, now);
  return input;
}

export function validateUpdateTodo(
  value: unknown,
  existing: Todo,
  now = getSingaporeNow(),
): UpdateTodoInput {
  const input = updateSchema.parse(value);
  validateRelationships(input, existing, now);
  return input;
}

export function todoWriteError(error: unknown): never {
  if (error instanceof Error && /^Tag \d+ does not belong to user \d+$/.test(error.message)) {
    throw new ApiError('One or more tags were not found');
  }
  throw error;
}
