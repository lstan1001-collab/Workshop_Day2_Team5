export const SINGAPORE_TIMEZONE = 'Asia/Singapore';

// Date represents an instant; never shift its epoch to simulate a timezone.
export function getSingaporeNow(): Date {
  return new Date();
}

export function formatSingaporeDate(
  value: Date | string,
  format = 'yyyy-MM-dd',
): string {
  const date = typeof value === 'string' ? parseSingaporeDate(value) : value;
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SINGAPORE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === name)!.value;
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  if (format === 'yyyy-MM-dd' || format === 'YYYY-MM-DD') return day;
  if (format === 'yyyy-MM-dd HH:mm:ss') {
    return `${day} ${part('hour')}:${part('minute')}:${part('second')}`;
  }
  throw new Error(`Unsupported Singapore date format: ${format}`);
}

export function parseSingaporeDate(value: string): Date {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(\.\d{1,3})?)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match || (!match[2] && match[5])) throw new Error('Invalid date');
  const local = `${match[1]}T${match[2] ?? '00:00'}:${match[3] ?? '00'}${match[4] ?? ''}`;
  const date = new Date(`${local}${match[5] ?? '+08:00'}`);
  const year = Number(match[1].slice(0, 4));
  const month = Number(match[1].slice(5, 7));
  const day = Number(match[1].slice(8, 10));
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!Number.isFinite(date.getTime()) || year < 100 || month < 1 ||
      month > 12 || day < 1 || day > maxDay) {
    throw new Error('Invalid date');
  }
  return date;
}
