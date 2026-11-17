import { describe, expect, it } from 'vitest';
import { generateCalendarGrid, parseCalendarMonth, shiftCalendarMonth, todoCalendarDate } from '@/lib/calendar';

describe('Singapore calendar', () => {
  it('uses 42 ordered Sunday-first cells across short, leap and six-week months', () => {
    const february = generateCalendarGrid(2026, 2);
    expect(february).toHaveLength(42);
    expect(february[0].date).toBe('2026-02-01');
    expect(february.filter(day => day.isCurrentMonth)).toHaveLength(28);
    const leap = generateCalendarGrid(2028, 2);
    expect(leap).toHaveLength(42);
    expect(leap.filter(day => day.isCurrentMonth)).toHaveLength(29);
    expect(leap.find(day => day.date === '2028-02-29')?.isCurrentMonth).toBe(true);
    const august = generateCalendarGrid(2026, 8);
    expect(august).toHaveLength(42);
    expect(august[0].date).toBe('2026-07-26');
    expect(august.at(-1)?.date).toBe('2026-09-05');
    expect(august.filter(day => day.isWeekend).map(day => day.date))
      .toEqual(august.filter((_, index) => index % 7 === 0 || index % 7 === 6).map(day => day.date));
  });

  it('keeps today, defaults and due-date grouping on Singapore dates near UTC midnight', () => {
    const now = new Date('2026-02-28T16:30:00Z');
    const grid = generateCalendarGrid(2026, 3, now);
    expect(grid.filter(day => day.isToday).map(day => day.date)).toEqual(['2026-03-01']);
    expect(generateCalendarGrid(2026, 2, now).find(day => day.date === '2026-02-28')?.isPast).toBe(true);
    expect(grid.find(day => day.date === '2026-03-01')?.isPast).toBe(false);
    expect(todoCalendarDate('2026-02-28T16:30:00Z')).toBe('2026-03-01');
    expect(todoCalendarDate('2026-03-01T00:30')).toBe('2026-03-01');
    expect(todoCalendarDate(null)).toBeNull();
    expect(todoCalendarDate('invalid')).toBeNull();
    for (const raw of [null, 'bad', '2026-13', '2026-00']) {
      expect(parseCalendarMonth(raw, now)).toEqual({ year: 2026, month: 3 });
    }
    expect(parseCalendarMonth('2028-02', now)).toEqual({ year: 2028, month: 2 });
  });

  it('navigates through year boundaries without month overflow', () => {
    expect(shiftCalendarMonth(2026, 12, 1)).toBe('2027-01');
    expect(shiftCalendarMonth(2026, 1, -1)).toBe('2025-12');
  });
});
