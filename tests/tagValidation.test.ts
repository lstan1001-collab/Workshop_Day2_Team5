import { describe, expect, it } from 'vitest';
import {
  validateCreateTag,
  validateTagId,
  validateTagLink,
  validateUpdateTag,
} from '@/lib/tagValidation';

describe('tag request validation', () => {
  it('trims tag names and accepts optional hex colors', () => {
    expect(validateCreateTag({ name: '  Work  ' })).toEqual({ name: 'Work' });
    expect(validateCreateTag({ name: 'Work', color: '#3B82F6' })).toEqual({
      name: 'Work',
      color: '#3B82F6',
    });
    expect(validateUpdateTag({ color: '#abcdef' })).toEqual({ color: '#abcdef' });
  });

  it('rejects empty names, invalid colors, empty updates, and unknown fields', () => {
    expect(() => validateCreateTag({ name: '  ' })).toThrow('Tag name is required');
    expect(() => validateCreateTag({ name: 'Work', color: 'red' }))
      .toThrow('Color must be a valid hex code');
    expect(() => validateUpdateTag({})).toThrow('At least one tag field is required');
    expect(() => validateUpdateTag({ name: 'Work', extra: true })).toThrow();
  });

  it('accepts only positive safe tag IDs and exact association payloads', () => {
    expect(validateTagId('12')).toBe(12);
    expect(() => validateTagId('0')).toThrow('Invalid tag ID');
    expect(() => validateTagId('9007199254740992')).toThrow('Invalid tag ID');
    expect(validateTagLink({ tag_id: 12 })).toEqual({ tag_id: 12 });
    expect(() => validateTagLink({ tag_id: 12, extra: true })).toThrow();
  });
});
