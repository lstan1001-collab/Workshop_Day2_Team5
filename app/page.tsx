'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { CreateTodoInput, Priority, RecurrencePattern, Subtask, Todo } from '@/lib/db';
import { formatSingaporeDate, getSingaporeNow, parseSingaporeDate, toSingaporeISO } from '@/lib/timezone';
import { calculateProgress, sectionTodos, validateDraft } from '@/lib/todoPresentation';
import { useNotifications } from '@/lib/hooks/useNotifications';

const reminders = [
  { minutes: 15, label: '15 minutes', badge: '15m' },
  { minutes: 30, label: '30 minutes', badge: '30m' },
  { minutes: 60, label: '1 hour', badge: '1h' },
  { minutes: 120, label: '2 hours', badge: '2h' },
  { minutes: 1440, label: '1 day', badge: '1d' },
  { minutes: 2880, label: '2 days', badge: '2d' },
  { minutes: 10080, label: '1 week', badge: '1w' },
];
const patterns: RecurrencePattern[] = ['daily', 'weekly', 'monthly', 'yearly'];
const priorities: Priority[] = ['high', 'medium', 'low'];

function useRequest() {
  const router = useRouter();
  return useCallback(async function request<T>(url: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method, signal, cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (response.status === 401) {
    router.replace('/login');
    throw new Error('Your session expired. Please sign in again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`);
  return data;
  }, [router]);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Something went wrong. Please try again.';
}

function Modal({ title, children, onClose, pending }: {
  title: string; children: ReactNode; onClose: () => void; pending: boolean;
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
  return <dialog ref={ref} aria-labelledby="edit-heading"
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget || pending) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <h2 id="edit-heading">{title}</h2>
    {children}
  </dialog>;
}

function TodoForm({ existing, pending, onSave, onCancel }: {
  existing?: Todo; pending: boolean; onSave: (input: CreateTodoInput) => Promise<void>; onCancel?: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [priority, setPriority] = useState<Priority>(existing?.priority ?? 'medium');
  const [due, setDue] = useState(() => {
    const parsed = existing?.due_date ? parseSingaporeDate(existing.due_date) : null;
    return parsed ? toSingaporeISO(parsed).slice(0, 16) : '';
  });
  const [repeat, setRepeat] = useState(existing?.is_recurring ?? false);
  const [pattern, setPattern] = useState<RecurrencePattern>(existing?.recurrence_pattern ?? 'daily');
  const [reminder, setReminder] = useState<number | null>(existing?.reminder_minutes ?? null);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const prefix = existing ? 'edit' : 'create';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || submitting.current) return;
    const input: CreateTodoInput = {
      title: title.trim(), priority, due_date: due ? `${due}+08:00` : null,
      is_recurring: repeat, recurrence_pattern: repeat ? pattern : null, reminder_minutes: reminder,
    };
    const invalid = validateDraft(input, getSingaporeNow(), existing?.due_date);
    if (invalid) { setError(invalid); return; }
    submitting.current = true;
    setError(null);
    try {
      await onSave(input);
      if (!existing) {
        setTitle(''); setDue(''); setPriority('medium'); setRepeat(false); setReminder(null); setPattern('daily');
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      submitting.current = false;
    }
  }

  return <form onSubmit={submit} aria-busy={pending}>
    <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0 }}>
      <label htmlFor={`${prefix}-title`}>Title
        <input id={`${prefix}-title`} value={title} onChange={event => setTitle(event.target.value)} required
          aria-describedby={error ? `${prefix}-error` : undefined} />
      </label>
      <div className="fields">
        <label htmlFor={`${prefix}-priority`}>Priority
          <select id={`${prefix}-priority`} value={priority} onChange={event => {
            const value = priorities.find(item => item === event.target.value);
            if (value) setPriority(value);
          }}>
            {priorities.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
          </select>
        </label>
        <label htmlFor={`${prefix}-due`}>Due date (Singapore)
          <input id={`${prefix}-due`} type="datetime-local" value={due} onChange={event => {
            setDue(event.target.value);
            if (!event.target.value) { setRepeat(false); setReminder(null); }
          }} />
        </label>
        <label htmlFor={`${prefix}-reminder`}>Reminder
          <select id={`${prefix}-reminder`} disabled={!due} value={reminder ?? ''}
            aria-describedby={`${prefix}-date-hint`}
            onChange={event => setReminder(event.target.value ? Number(event.target.value) : null)}>
            <option value="">None</option>
            {reminders.map(item => <option key={item.minutes} value={item.minutes}>{item.label} before</option>)}
          </select>
        </label>
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={repeat} disabled={!due}
          aria-describedby={`${prefix}-date-hint`} onChange={event => setRepeat(event.target.checked)} />Repeat</label>
        {repeat && <label>Recurrence pattern
          <select value={pattern} onChange={event => {
            const value = patterns.find(item => item === event.target.value);
            if (value) setPattern(value);
          }}>{patterns.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select>
        </label>}
      </div>
      <p className="muted" id={`${prefix}-date-hint`}>Set a due date to enable repeat and reminders. All times are Singapore time (UTC+08:00).</p>
      {error && <p className="error" id={`${prefix}-error`} role="alert">{error}</p>}
      <div className="row">
        <button className="primary" type="submit">{pending ? 'Saving...' : existing ? 'Update' : 'Add'}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </fieldset>
  </form>;
}

function Subtasks({ todo, pending, onChange }: {
  todo: Todo; pending: boolean;
  onChange: (todo: Todo, action: 'add' | 'toggle' | 'delete', title?: string, subtask?: Subtask) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const progress = calculateProgress(todo.subtasks ?? []);
  async function change(action: 'add' | 'toggle' | 'delete', subtask?: Subtask) {
    if (pending) return;
    setError(null);
    if (action === 'add' && !title.trim()) { setError('Subtask title is required'); return; }
    try {
      await onChange(todo, action, title.trim(), subtask);
      if (action === 'add') setTitle('');
    } catch (cause) { setError(message(cause)); }
  }
  return <div>
    <button type="button" aria-expanded={expanded} aria-controls={`subtasks-${todo.id}`}
      onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide' : 'Show'} Subtasks</button>
    {progress.total > 0 && <div>
      <p className="muted" aria-live="polite">{progress.completed}/{progress.total} subtasks ({progress.percent}%)</p>
      <div className="progress-track" role="progressbar" aria-label={`Subtask progress for ${todo.title}`}
        aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
        <div className={`progress-fill${progress.percent === 100 ? ' complete' : ''}`} style={{ width: `${progress.percent}%` }} />
      </div>
    </div>}
    {expanded && <div id={`subtasks-${todo.id}`} aria-busy={pending}>
      <ul className="subtasks">
        {[...(todo.subtasks ?? [])].sort((a, b) => a.position - b.position).map(subtask => <li key={subtask.id}>
          <label className="check">
            <input type="checkbox" checked={subtask.completed} disabled={pending}
              onChange={() => void change('toggle', subtask)} />
            <span className={subtask.completed ? 'done' : ''}>{subtask.title}</span>
          </label>
          <button type="button" disabled={pending} className="danger"
            aria-label={`Delete subtask ${subtask.title}`} onClick={() => void change('delete', subtask)}>Delete</button>
        </li>)}
      </ul>
      <form className="row" onSubmit={event => { event.preventDefault(); void change('add'); }}>
        <label style={{ flex: 1 }} htmlFor={`subtask-title-${todo.id}`}>New subtask
          <input id={`subtask-title-${todo.id}`} value={title} disabled={pending}
            onChange={event => setTitle(event.target.value)} />
        </label>
        <button disabled={pending} type="submit">Add subtask</button>
      </form>
    </div>}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}

export default function TodoPage() {
  const router = useRouter();
  const request = useRequest();
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<Todo | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const locks = useRef(new Set<string>());
  const [now, setNow] = useState(getSingaporeNow);
  const notifications = useNotifications();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const data = await request<Todo[]>('/api/todos', 'GET', undefined, signal);
    setTodos(data);
  }, [request]);
  useEffect(() => {
    const controller = new AbortController();
    request<Todo[]>('/api/todos', 'GET', undefined, controller.signal).then(data => {
      if (!controller.signal.aborted) setTodos(data);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(message(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const timer = window.setInterval(() => setNow(getSingaporeNow()), 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [request]);

  function lock(key: string) {
    if (locks.current.has(key)) return false;
    locks.current.add(key);
    setPending(new Set(locks.current));
    return true;
  }
  function unlock(key: string) {
    locks.current.delete(key);
    setPending(new Set(locks.current));
  }
  function replace(todo: Todo) {
    setTodos(current => current.map(item => item.id === todo.id ? todo : item));
  }

  async function save(input: CreateTodoInput, original?: Todo) {
    const key = original ? `todo-${original.id}` : 'create';
    if (!lock(key)) return;
    try {
      if (original) {
        const result = await request<Todo | { todo: Todo; nextInstance?: Todo }>(`/api/todos/${original.id}`, 'PUT', input);
        replace('todo' in result ? result.todo : result);
        setEditing(null);
      } else {
        const todo = await request<Todo>('/api/todos', 'POST', input);
        setTodos(current => [...current, todo]);
      }
      setStatus(original ? 'Todo updated.' : 'Todo added.');
    } finally { unlock(key); }
  }

  async function mutate(todo: Todo, action: 'toggle' | 'delete') {
    const key = `todo-${todo.id}`;
    if (!lock(key)) return;
    setError(null);
    if (action === 'delete') setTodos(current => current.filter(item => item.id !== todo.id));
    else replace({ ...todo, completed: !todo.completed });
    try {
      if (action === 'delete') {
        await request(`/api/todos/${todo.id}`, 'DELETE');
        setStatus('Todo deleted.');
      } else {
        const result = await request<Todo | { todo: Todo; nextInstance?: Todo }>(`/api/todos/${todo.id}`, 'PUT', { completed: !todo.completed });
        const saved = 'todo' in result ? result.todo : result;
        const next = 'todo' in result ? result.nextInstance : undefined;
        setTodos(current => [
          ...current.map(item => item.id === saved.id ? saved : item),
          ...(next && !current.some(item => item.id === next.id) ? [next] : []),
        ]);
        setStatus(next ? 'Todo completed. Next recurring instance added.' : 'Completion updated.');
      }
    } catch (cause) {
      if (action === 'delete') setTodos(current => [...current, todo]);
      else replace(todo);
      setError(message(cause));
    } finally { unlock(key); }
  }

  async function changeSubtask(todo: Todo, action: 'add' | 'toggle' | 'delete', title = '', subtask?: Subtask) {
    const key = `todo-${todo.id}`;
    if (!lock(key)) return;
    const temporary: Subtask = {
      id: -getSingaporeNow().getTime(), todo_id: todo.id, title, completed: false,
      position: Math.max(-1, ...(todo.subtasks ?? []).map(item => item.position)) + 1,
      created_at: getSingaporeNow().toISOString(),
    };
    const original = todo.subtasks ?? [];
    const optimistic = action === 'add' ? [...original, temporary] :
      action === 'delete' ? original.filter(item => item.id !== subtask?.id) :
        original.map(item => item.id === subtask?.id ? { ...item, completed: !item.completed } : item);
    replace({ ...todo, subtasks: optimistic });
    try {
      if (action === 'add') {
        const saved = await request<Subtask>(`/api/todos/${todo.id}/subtasks`, 'POST', { title });
        replace({ ...todo, subtasks: optimistic.map(item => item.id === temporary.id ? saved : item) });
      } else if (subtask) {
        if (action === 'delete') await request(`/api/subtasks/${subtask.id}`, 'DELETE');
        else {
          const saved = await request<Subtask>(`/api/subtasks/${subtask.id}`, 'PUT', { completed: !subtask.completed });
          replace({ ...todo, subtasks: original.map(item => item.id === saved.id ? saved : item) });
        }
      }
      setStatus('Subtasks updated.');
    } catch (cause) {
      replace(todo);
      throw cause;
    } finally { unlock(key); }
  }

  async function logout() {
    if (!lock('logout')) return;
    try { await request('/api/auth/logout', 'POST'); router.replace('/login'); }
    catch (cause) { setError(message(cause)); }
    finally { unlock('logout'); }
  }

  const sections = sectionTodos(todos, now);
  return <main>
    <header className="row between">
      <div><h1>Todo planner</h1><p className="muted">Make room for what matters. Singapore time.</p></div>
      <button onClick={() => void logout()} disabled={pending.has('logout')}>Logout</button>
    </header>
    <section className="panel" aria-labelledby="new-todo">
      <h2 id="new-todo">Add a todo</h2>
      <TodoForm pending={pending.has('create')} onSave={input => save(input)} />
    </section>
    <section className="panel" aria-label="Browser reminders">
      <button onClick={() => void notifications.requestPermission()}
        disabled={notifications.permission !== 'default'}>
        {notifications.permission === 'granted' ? 'Notifications On' :
          notifications.permission === 'unsupported' ? 'Notifications unavailable' :
            notifications.permission === 'denied' ? 'Notifications blocked' : 'Enable Notifications'}
      </button>
      <p className="muted">Reminders need an open app tab and browser permission. Multiple-tab delivery is best-effort.</p>
      {notifications.permission === 'denied' && <p>Allow notifications in this site&apos;s browser settings to enable reminders.</p>}
      {notifications.error && <p role="alert" className="error">{notifications.error}</p>}
    </section>
    <p role="status" className="sr-only">{status}</p>
    {error && <div role="alert" className="error">{error}
      <button onClick={async () => {
        if (!lock('refresh')) return;
        try { await refresh(); setError(null); } catch (cause) { setError(message(cause)); }
        finally { unlock('refresh'); }
      }} disabled={pending.has('refresh')}>Retry loading todos</button>
    </div>}
    {loading ? <p role="status">Loading todos...</p> : !error && todos.length === 0 ? <p>You have no todos yet.</p> : null}
    {Object.entries(sections).map(([name, tasks]) => tasks.length > 0 && <section key={name} aria-label={name}>
      <h2>{name} ({tasks.length})</h2>
      <ul className="todo-list">
        {tasks.map(todo => <li className="todo" key={todo.id} aria-busy={pending.has(`todo-${todo.id}`)}>
          <div className="row between">
            <label className="check" style={{ minWidth: 0, flex: 1 }}>
              <input type="checkbox" checked={todo.completed} disabled={pending.has(`todo-${todo.id}`)}
                aria-label={`Mark "${todo.title}" as ${todo.completed ? 'incomplete' : 'complete'}`}
                onChange={() => void mutate(todo, 'toggle')} />
              <span className={`todo-title${todo.completed ? ' done' : ''}`}>{todo.title}</span>
            </label>
            <div className="row">
              <button onClick={() => setEditing(todo)} disabled={pending.has(`todo-${todo.id}`)}>Edit</button>
              <button className="danger" onClick={() => void mutate(todo, 'delete')} disabled={pending.has(`todo-${todo.id}`)}>Delete</button>
            </div>
          </div>
          {todo.due_date && <p className="muted">Due {formatSingaporeDate(todo.due_date)} (Singapore)</p>}
          <div className="badges">
            <span className={`badge priority-${todo.priority}`}>{todo.priority[0].toUpperCase() + todo.priority.slice(1)}</span>
            {todo.is_recurring && <span className="badge">Repeat: {todo.recurrence_pattern}</span>}
            {todo.reminder_minutes != null && <span className="badge">Reminder: {reminders.find(item => item.minutes === todo.reminder_minutes)?.badge}</span>}
          </div>
          <hr />
          <Subtasks todo={todo} pending={pending.has(`todo-${todo.id}`)} onChange={changeSubtask} />
        </li>)}
      </ul>
    </section>)}
    {editing && <Modal title="Edit todo" pending={pending.has(`todo-${editing.id}`)} onClose={() => setEditing(null)}>
      <TodoForm existing={editing} pending={pending.has(`todo-${editing.id}`)}
        onSave={input => save(input, editing)} onCancel={() => setEditing(null)} />
    </Modal>}
  </main>;
}
