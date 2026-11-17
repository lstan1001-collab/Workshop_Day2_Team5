import { describe, expect, it } from 'vitest';
import { calculateNextDueDate } from '@/lib/recurrence';

describe('calculateNextDueDate', () => {
  it.each([
    ['daily', '2025-11-10T14:00:00+08:00', '2025-11-11T14:00:00.000+08:00'],
    ['weekly', '2025-11-10T14:00:00+08:00', '2025-11-17T14:00:00.000+08:00'],
    ['monthly', '2025-06-15T09:00:00+08:00', '2025-07-15T09:00:00.000+08:00'],
    ['monthly', '2025-01-31T09:00:00+08:00', '2025-02-28T09:00:00.000+08:00'],
    ['monthly', '2024-01-31T09:00:00+08:00', '2024-02-29T09:00:00.000+08:00'],
    ['monthly', '2025-12-31T09:00:00+08:00', '2026-01-31T09:00:00.000+08:00'],
    ['yearly', '2025-06-15T09:00:00+08:00', '2026-06-15T09:00:00.000+08:00'],
    ['yearly', '2024-02-29T09:00:00+08:00', '2025-02-28T09:00:00.000+08:00'],
  ] as const)('%s cadence from %s preserves Singapore time', (pattern, current, expected) => {
    expect(calculateNextDueDate(current, pattern)).toBe(expected);
  });

  it('handles offset-bearing due dates by their Singapore-local calendar date', () => {
    expect(calculateNextDueDate('2025-11-10T06:00:00Z', 'daily'))
      .toBe('2025-11-11T14:00:00.000+08:00');
  });

  it('rejects malformed due dates', () => {
    expect(() => calculateNextDueDate('not-a-date', 'daily')).toThrow(RangeError);
  });
});
