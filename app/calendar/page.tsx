'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Holiday, Todo } from '@/lib/db';
import { calendarMonthKey, generateCalendarGrid, parseCalendarMonth, shiftCalendarMonth, todoCalendarDate } from '@/lib/calendar';
import { formatSingaporeDate, getSingaporeNow, toSingaporeISO } from '@/lib/timezone';

function dateLabel(date: string): string {
  return formatSingaporeDate(`${date}T12:00:00+08:00`, { dateStyle: 'full', timeStyle: undefined });
}

function DayDetails({ date, todos, holiday, onClose }: {
  date: string; todos: Todo[]; holiday?: Holiday; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return <dialog ref={ref} aria-labelledby="day-heading" onCancel={event => {
    event.preventDefault(); onClose();
  }}>
    <h2 id="day-heading">{dateLabel(date)}</h2>
    {holiday && <p className="holiday-label">{holiday.name}</p>}
    {todos.length === 0 ? <p>No todos due this day.</p> : <ul className="template-list">
      {todos.map(todo => <li className="panel" key={todo.id}>
        <p className={todo.completed ? 'done' : ''}>{todo.title}</p>
        <span className={`badge priority-${todo.priority}`}>{todo.priority}</span>
        <p>{todo.completed ? 'Completed' : 'Incomplete'}</p>
      </li>)}
    </ul>}
    <p className="muted">Read-only view. Edit todos in the list.</p>
    <button type="button" onClick={onClose}>Close</button>
  </dialog>;
}

function CalendarView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [now, setNow] = useState(getSingaporeNow);
  const { year, month } = parseCalendarMonth(searchParams.get('month'), now);
  const monthKey = calendarMonthKey(year, month);
  const [result, setResult] = useState<{
    month: string; todos: Todo[]; holidays: Holiday[]; error: string | null;
  }>({ month: '', todos: [], holidays: [], error: null });
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<{ month: string; date: string } | null>(null);
  const loading = result.month !== monthKey;
  const days = useMemo(() => generateCalendarGrid(year, month, now), [year, month, now]);
  const todosByDate = useMemo(() => {
    const grouped = new Map<string, Todo[]>();
    for (const todo of result.todos) {
      const date = todoCalendarDate(todo.due_date);
      if (date) grouped.set(date, [...(grouped.get(date) ?? []), todo]);
    }
    return grouped;
  }, [result.todos]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(getSingaporeNow()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function read<T>(url: string): Promise<T> {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (response.status === 401) {
        router.replace('/login');
        throw new Error('Your session expired. Please sign in again.');
      }
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error : `Could not load calendar (${response.status}).`);
      if (data === null) throw new Error('The server returned an invalid response.');
      return data as T;
    }
    Promise.all([
      read<Todo[]>('/api/todos'),
      read<{ holidays: Holiday[] }>(`/api/holidays?year=${year}&month=${month}`),
    ]).then(([todos, { holidays }]) => {
      if (!controller.signal.aborted) setResult({ month: monthKey, todos, holidays, error: null });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setResult({
        month: monthKey, todos: [], holidays: [],
        error: cause instanceof Error ? cause.message : 'Could not load calendar.',
      });
    });
    return () => controller.abort();
  }, [year, month, monthKey, retry, router]);

  function navigate(value: string) {
    setSelection(null);
    router.replace(`/calendar?month=${value}`);
  }
  const heading = formatSingaporeDate(`${monthKey}-01T12:00:00+08:00`, {
    dateStyle: undefined, timeStyle: undefined, month: 'long', year: 'numeric',
  });
  const selectedDate = selection?.month === monthKey ? selection.date : null;
  return <main className="calendar-page">
    <header className="row between">
      <div><h1>Calendar</h1><p className="muted">All due-dated todos, in Singapore time. List filters do not apply.</p></div>
      <Link href="/">Back to list</Link>
    </header>
    <section className="panel" aria-labelledby="month-heading" aria-busy={loading}>
      <div className="row between calendar-navigation">
        <h2 id="month-heading" aria-live="polite">{heading}</h2>
        <div className="row">
          <button onClick={() => navigate(shiftCalendarMonth(year, month, -1))} aria-label="Previous month">Previous</button>
          <button onClick={() => navigate(toSingaporeISO(getSingaporeNow()).slice(0, 7))}>Today</button>
          <button onClick={() => navigate(shiftCalendarMonth(year, month, 1))} aria-label="Next month">Next</button>
        </div>
      </div>
      {loading ? <p role="status">Loading calendar...</p> : result.error ? <div role="alert" className="error">
        {result.error} <button onClick={() => {
          setResult(current => ({ ...current, month: '' })); setRetry(value => value + 1);
        }}>Retry loading calendar</button>
      </div> : <>
        <div className="calendar-scroll">
          <table className="calendar-table" aria-labelledby="month-heading">
            <thead><tr>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => <th scope="col" key={day}>{day}</th>)}</tr></thead>
            <tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>
              {days.slice(week * 7, week * 7 + 7).map(day => {
                const todos = todosByDate.get(day.date) ?? [];
                const holiday = result.holidays.find(item => item.date === day.date);
                return <td key={day.date}>
                  <button className={`calendar-cell${day.isCurrentMonth ? '' : ' adjacent-month'}${day.isToday ? ' today' : ''}${day.isPast ? ' past' : ''}${day.isWeekend ? ' weekend' : ''}`}
                    aria-current={day.isToday ? 'date' : undefined}
                    aria-label={`${dateLabel(day.date)}: ${todos.length} todos${holiday ? `; ${holiday.name}` : ''}`}
                    onClick={() => setSelection({ month: monthKey, date: day.date })}>
                    <span className="calendar-date">{Number(day.date.slice(-2))}</span>
                    {holiday && <span className="holiday-label">{holiday.name}</span>}
                    {todos.slice(0, 3).map(todo => <span key={todo.id} className={`calendar-pill priority-${todo.priority}${todo.completed ? ' done' : ''}`}>
                      {todo.title}
                    </span>)}
                    {todos.length > 3 && <span className="calendar-overflow">+{todos.length - 3} more</span>}
                  </button>
                </td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
        {!days.some(day => todosByDate.has(day.date)) && <p role="status">No todos due in this calendar view.</p>}
      </>}
    </section>
    {selectedDate && !loading && !result.error && <DayDetails date={selectedDate}
      todos={todosByDate.get(selectedDate) ?? []}
      holiday={result.holidays.find(item => item.date === selectedDate)} onClose={() => setSelection(null)} />}
  </main>;
}

const subscribeToClient = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export default function CalendarPage() {
  const isClient = useSyncExternalStore(subscribeToClient, clientSnapshot, serverSnapshot);
  const loading = <main><p role="status">Loading calendar...</p></main>;
  return <Suspense fallback={loading}>{isClient ? <CalendarView /> : loading}</Suspense>;
}
