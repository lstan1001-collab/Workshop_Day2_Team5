import type { RecurrencePattern } from '@/lib/db';
import { parseSingaporeDate, toSingaporeISO } from '@/lib/timezone';

const SINGAPORE_OFFSET_MS = 8 * 60 * 60_000;

type SingaporeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

function getSingaporeParts(value: string): SingaporeParts {
  const parsed = parseSingaporeDate(value);
  if (!parsed) throw new RangeError('Invalid Singapore due date');

  const local = new Date(parsed.getTime() + SINGAPORE_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    millisecond: local.getUTCMilliseconds(),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addDays(parts: SingaporeParts, days: number): SingaporeParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { ...parts, year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function toSingaporeDate(parts: SingaporeParts): string {
  const utc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  return toSingaporeISO(new Date(utc - SINGAPORE_OFFSET_MS));
}

export function calculateNextDueDate(
  currentDueDate: string,
  pattern: RecurrencePattern,
): string {
  const current = getSingaporeParts(currentDueDate);

  switch (pattern) {
    case 'daily':
      return toSingaporeDate(addDays(current, 1));
    case 'weekly':
      return toSingaporeDate(addDays(current, 7));
    case 'monthly': {
      const month = current.month === 12 ? 1 : current.month + 1;
      const year = current.month === 12 ? current.year + 1 : current.year;
      return toSingaporeDate({
        ...current,
        year,
        month,
        day: Math.min(current.day, daysInMonth(year, month)),
      });
    }
    case 'yearly': {
      const year = current.year + 1;
      return toSingaporeDate({
        ...current,
        year,
        day: Math.min(current.day, daysInMonth(year, current.month)),
      });
    }
  }
}
