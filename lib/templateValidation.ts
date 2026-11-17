import { z } from 'zod';
import { ApiError } from '@/lib/api';
import type { CreateTemplateInput, Template, UpdateTemplateInput } from '@/lib/db';
import { prioritySchema, recurrencePatternSchema, reminderMinutesSchema } from '@/lib/todoValidation';
import { getSingaporeNow, toSingaporeISO } from '@/lib/timezone';

const checklistSchema = z.array(z.strictObject({
  title: z.string().trim().min(1, 'Subtask title is required'),
  position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})).transform((items) => items.map((item, position) => ({ ...item, position })));
const fields = {
  name: z.string().trim().min(1, 'Template name is required'),
  title_template: z.string().trim().min(1, 'Title is required'),
  description: z.string().trim().nullable().optional(),
  category: z.string().trim().nullable().optional(),
  priority: prioritySchema.optional(),
  is_recurring: z.boolean().optional(),
  recurrence_pattern: recurrencePatternSchema.nullable().optional(),
  reminder_minutes: reminderMinutesSchema.nullable().optional(),
  due_date_offset_minutes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  subtasks: checklistSchema.optional(),
};
const createSchema = z.strictObject(fields);
const updateSchema = createSchema.partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one template field is required');

export function validateTemplateId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ApiError('Invalid template ID');
  }
  return Number(value);
}

export function templateDueDate(
  input: Pick<CreateTemplateInput, 'is_recurring' | 'recurrence_pattern' | 'reminder_minutes' | 'due_date_offset_minutes'>,
  now = getSingaporeNow(),
): string | null {
  if (input.is_recurring && !input.recurrence_pattern) {
    throw new ApiError('Recurring templates require a recurrence pattern');
  }
  if (input.due_date_offset_minutes == null) {
    if (input.is_recurring || input.reminder_minutes != null) {
      throw new ApiError('Recurring or reminder templates require a due date offset');
    }
    return null;
  }
  const due = new Date(now.getTime() + input.due_date_offset_minutes * 60_000);
  if (!Number.isFinite(due.getTime()) || due.getUTCFullYear() > 9999) {
    throw new ApiError('Due date offset is out of range');
  }
  return toSingaporeISO(due);
}

export function validateCreateTemplate(value: unknown): CreateTemplateInput {
  const input = createSchema.parse(value);
  templateDueDate(input);
  return input;
}

export function validateUpdateTemplate(value: unknown, existing: Template): UpdateTemplateInput {
  const input = updateSchema.parse(value);
  templateDueDate({ ...existing, ...input });
  return input;
}

export function validateStoredTemplate(template: Template): void {
  try {
    validateCreateTemplate({
      name: template.name,
      title_template: template.title_template,
      description: template.description,
      category: template.category,
      priority: template.priority,
      is_recurring: template.is_recurring,
      recurrence_pattern: template.recurrence_pattern,
      reminder_minutes: template.reminder_minutes,
      due_date_offset_minutes: template.due_date_offset_minutes,
      subtasks: template.subtasks_json == null ? [] : JSON.parse(template.subtasks_json),
    });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof ApiError) {
      throw new Error('Stored template is invalid', { cause: error });
    }
    throw error;
  }
}
