export const SINGAPORE_TIMEZONE = 'Asia/Singapore';

export function getSingaporeNow(): Date {
  return new Date();
}

export function formatSingaporeDate(
  value: Date | string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat('en-SG', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
    timeZone: SINGAPORE_TIMEZONE,
  }).format(typeof value === 'string' ? new Date(value) : value);
}

export function toSingaporeISO(value: Date): string {
  return new Date(value.getTime() + 8 * 60 * 60_000)
    .toISOString()
    .replace('Z', '+08:00');
}

export function parseSingaporeDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', , offset] = match;
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (
    Number(month) < 1 || Number(month) > 12 ||
    Number(day) < 1 || Number(day) > daysInMonth ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
  ) return null;
  const result = new Date(offset ? value : `${value}+08:00`);
  return Number.isFinite(result.getTime()) ? result : null;
}
