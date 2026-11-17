import { getSingaporeNow, parseSingaporeDate, toSingaporeISO } from './timezone';

export interface CalendarDay {
  date: string;
  isCurrentMonth: boolean;
  isToday: boolean;
  isPast: boolean;
  isWeekend: boolean;
}

function civilDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function parseCalendarMonth(raw: string | null, now = getSingaporeNow()): { year: number; month: number } {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) {
    const [year, month] = raw.split('-').map(Number);
    if (month >= 1 && month <= 12) return { year, month };
  }
  const [year, month] = toSingaporeISO(now).slice(0, 7).split('-').map(Number);
  return { year, month };
}

export function calendarMonthKey(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function shiftCalendarMonth(year: number, month: number, delta: number): string {
  const date = civilDate(year, month + delta, 1);
  return calendarMonthKey(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

export function generateCalendarGrid(year: number, month: number, now = getSingaporeNow()): CalendarDay[] {
  const startWeekday = civilDate(year, month, 1).getUTCDay();
  const today = toSingaporeISO(now).slice(0, 10);
  return Array.from({ length: 42 }, (_, index) => {
    const value = civilDate(year, month, index - startWeekday + 1);
    const date = value.toISOString().slice(0, 10);
    return {
      date,
      isCurrentMonth: value.getUTCFullYear() === year && value.getUTCMonth() + 1 === month,
      isToday: date === today,
      isPast: date < today,
      isWeekend: index % 7 === 0 || index % 7 === 6,
    };
  });
}

export function todoCalendarDate(dueDate: string | null): string | null {
  const parsed = dueDate ? parseSingaporeDate(dueDate) : null;
  return parsed ? toSingaporeISO(parsed).slice(0, 10) : null;
}
