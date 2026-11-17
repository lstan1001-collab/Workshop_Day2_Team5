import { z } from 'zod';
import type { CreateTagInput, UpdateTagInput } from '@/lib/db';

const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must be a valid hex code');
const createTagSchema = z.strictObject({
  name: z.string().trim().min(1, 'Tag name is required'),
  color: colorSchema.optional(),
});
const updateTagSchema = z.strictObject({
  name: z.string().trim().min(1, 'Tag name is required').optional(),
  color: colorSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'At least one tag field is required');
const tagIdSchema = z.string()
  .regex(/^[1-9]\d*$/, 'Invalid tag ID')
  .transform(Number)
  .refine(Number.isSafeInteger, 'Invalid tag ID');
const tagLinkSchema = z.strictObject({
  tag_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export function validateTagId(value: string): number {
  return tagIdSchema.parse(value);
}

export function validateCreateTag(value: unknown): CreateTagInput {
  return createTagSchema.parse(value);
}

export function validateUpdateTag(value: unknown): UpdateTagInput {
  return updateTagSchema.parse(value);
}

export function validateTagLink(value: unknown): { tag_id: number } {
  return tagLinkSchema.parse(value);
}
