'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { CreateTagInput, CreateTodoInput, Priority, RecurrencePattern, Subtask, Tag, Todo, UpdateTagInput } from '@/lib/db';
import { formatSingaporeDate, getSingaporeNow, parseSingaporeDate, toSingaporeISO } from '@/lib/timezone';
import { calculateProgress, sectionTodos, validateDraft } from '@/lib/todoPresentation';
import { applyFilters, DEFAULT_FILTER_STATE, deletePreset, hasActiveFilters, loadPresets, savePreset } from '@/lib/filters';
import type { FilterPreset, FilterState } from '@/lib/filters';
import { useDebounce } from '@/lib/hooks/useDebounce';
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
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = typeof data === 'object' && data !== null && 'error' in data &&
      typeof data.error === 'string' ? data.error : `Request failed (${response.status})`;
    throw new Error(error);
  }
  if (data === null) throw new Error('The server returned an invalid response.');
  return data as T;
  }, [router]);
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Something went wrong. Please try again.';
}

function Modal({ title, children, onClose, pending }: {
  title: string; children: ReactNode; onClose: () => void; pending: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return <dialog ref={ref} aria-labelledby={headingId}
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget || pending) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right ||
          event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <h2 id={headingId}>{title}</h2>
    {children}
  </dialog>;
}

function tagTextColor(color: string): string {
  const channels = color.slice(1).match(/.{2}/g)?.map(channel => parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3 || channels.some(channel => !Number.isFinite(channel))) return '#111827';
  const luminance = channels
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? '#fff' : '#111827';
}

function TagPill({ tag, selected = false, onClick, actionLabel }: {
  tag: Tag; selected?: boolean; onClick?: () => void; actionLabel?: string;
}) {
  const content = <>{selected && <span aria-hidden="true">✓ </span>}<span className="tag-name">{tag.name}</span></>;
  const className = `tag-pill${selected ? ' selected' : ''}`;
  const style = { backgroundColor: tag.color, color: tagTextColor(tag.color) };
  return onClick
    ? <button type="button" className={className} aria-pressed={selected}
        aria-label={actionLabel ?? `Select tag ${tag.name}`} style={style} onClick={onClick}>{content}</button>
    : <span className={className} style={style}>{content}</span>;
}

function TodoForm({ existing, pending, onSave, onCancel, tags }: {
  existing?: Todo; pending: boolean; onSave: (input: CreateTodoInput) => Promise<void>;
  onCancel?: () => void; tags: Tag[];
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
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>(() => existing?.tags?.map(tag => tag.id) ?? []);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const prefix = existing ? 'edit' : 'create';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || submitting.current) return;
    const input: CreateTodoInput = {
      title: title.trim(), priority, due_date: due ? `${due}+08:00` : null,
      is_recurring: repeat, recurrence_pattern: repeat ? pattern : null, reminder_minutes: reminder,
      tag_ids: selectedTagIds.filter(id => tags.some(tag => tag.id === id)),
    };
    const invalid = validateDraft(input, getSingaporeNow(), existing?.due_date);
    if (invalid) { setError(invalid); return; }
    submitting.current = true;
    setError(null);
    try {
      await onSave(input);
      if (!existing) {
        setTitle(''); setDue(''); setPriority('medium'); setRepeat(false); setReminder(null); setPattern('daily');
        setSelectedTagIds([]);
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
      <fieldset className="tag-selector" disabled={pending}>
        <legend>Tags</legend>
        {tags.length === 0 ? <p className="muted">No tags yet. Use Manage Tags to create one.</p> :
          <div className="row">
            {tags.map(tag => <TagPill key={tag.id} tag={tag} selected={selectedTagIds.includes(tag.id)}
              actionLabel={`Select tag ${tag.name}`}
              onClick={() => setSelectedTagIds(current => current.includes(tag.id)
                ? current.filter(id => id !== tag.id) : [...current, tag.id])} />)}
          </div>}
      </fieldset>
      {error && <p className="error" id={`${prefix}-error`} role="alert">{error}</p>}
      <div className="row">
        <button className="primary" type="submit">{pending ? 'Saving...' : existing ? 'Update' : 'Add'}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </fieldset>
  </form>;
}

function ManageTagsModal({ tags, loading, error, pending, onClose, onCreate, onUpdate, onDelete }: {
  tags: Tag[]; loading: boolean; error: string | null; pending: boolean; onClose: () => void;
  onCreate: (input: CreateTagInput) => Promise<void>;
  onUpdate: (id: number, input: UpdateTagInput) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3B82F6');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function edit(tag: Tag) {
    setEditingId(tag.id);
    setName(tag.name);
    setColor(tag.color);
    setActionError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setName('');
    setColor('#3B82F6');
    setActionError(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setActionError(null);
    try {
      if (editingId === null) await onCreate({ name, color });
      else await onUpdate(editingId, { name, color });
      cancelEdit();
    } catch (cause) {
      setActionError(message(cause));
    }
  }

  async function remove(tag: Tag) {
    if (pending || !window.confirm(`Delete the "${tag.name}" tag? It will be removed from all todos.`)) return;
    setActionError(null);
    try {
      await onDelete(tag.id);
      if (editingId === tag.id) cancelEdit();
    } catch (cause) {
      setActionError(message(cause));
    }
  }

  return <Modal title="Manage Tags" onClose={onClose} pending={pending}>
    {loading && <p role="status">Loading tags...</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {actionError && <p role="alert" className="error">{actionError}</p>}
    {!loading && !error && tags.length === 0 ? <p className="muted">No tags yet.</p> : null}
    <ul className="tag-list">
      {tags.map(tag => <li key={tag.id} className="row between">
        <TagPill tag={tag} selected />
        <div className="row">
          <button type="button" disabled={pending} onClick={() => edit(tag)}>Edit</button>
          <button type="button" className="danger" disabled={pending}
            onClick={() => void remove(tag)}>Delete</button>
        </div>
      </li>)}
    </ul>
    <form onSubmit={submit} aria-busy={pending}>
      <label htmlFor="tag-name">{editingId === null ? 'New tag name' : 'Edit tag name'}
        <input id="tag-name" value={name} onChange={event => setName(event.target.value)} required disabled={pending} />
      </label>
      <div className="tag-color-fields">
        <label htmlFor="tag-color">Color
          <input id="tag-color" type="color" value={/^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#3B82F6'}
            onChange={event => setColor(event.target.value)} disabled={pending} />
        </label>
        <label htmlFor="tag-color-hex">Hex color
          <input id="tag-color-hex" value={color} maxLength={7} pattern="#[0-9A-Fa-f]{6}"
            onChange={event => setColor(event.target.value)} disabled={pending}
            aria-describedby="tag-color-hint" />
        </label>
      </div>
      <p className="muted" id="tag-color-hint">Use a six-digit hex color, such as #3B82F6.</p>
      <div className="row">
        <button type="submit" className="primary" disabled={pending}>
          {pending ? 'Saving...' : editingId === null ? 'Create Tag' : 'Update Tag'}
        </button>
        {editingId !== null && <button type="button" disabled={pending} onClick={cancelEdit}>Cancel edit</button>}
        <button type="button" disabled={pending} onClick={onClose}>Close</button>
      </div>
    </form>
  </Modal>;
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
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<Todo | null>(null);
  const [managingTags, setManagingTags] = useState(false);
  const [filters, setFilters] = useState<FilterState>({ ...DEFAULT_FILTER_STATE });
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetError, setPresetError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const locks = useRef(new Set<string>());
  const [now, setNow] = useState(getSingaporeNow);
  const notifications = useNotifications();
  const debouncedSearch = useDebounce(filters.search, 300);
  const filteredTodos = useMemo(() => applyFilters(todos, {
    ...filters,
    search: filters.search === '' ? '' : debouncedSearch,
  }), [todos, filters, debouncedSearch]);
  const sections = useMemo(() => sectionTodos(filteredTodos, now), [filteredTodos, now]);

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
  useEffect(() => {
    const controller = new AbortController();
    request<Tag[]>('/api/tags', 'GET', undefined, controller.signal).then(data => {
      if (!controller.signal.aborted) {
        setTags(data);
        setTagsError(null);
        setFilters(current => current.tagId === 'all' ||
          data.some(tag => tag.id === current.tagId)
          ? current
          : { ...current, tagId: 'all' });
      }
    }).catch(cause => {
      if (!controller.signal.aborted) setTagsError(message(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setTagsLoading(false);
    });
    return () => controller.abort();
  }, [request]);
  useEffect(() => {
    const timer = window.setTimeout(() => setPresets(loadPresets()), 0);
    return () => window.clearTimeout(timer);
  }, []);

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

  async function createTag(input: CreateTagInput) {
    if (!lock('tags')) throw new Error('Another tag change is already in progress.');
    try {
      const tag = await request<Tag>('/api/tags', 'POST', input);
      setTags(current => [...current, tag].sort((a, b) => a.name.localeCompare(b.name)));
      setTagsError(null);
      setStatus(`Tag "${tag.name}" created.`);
    } finally { unlock('tags'); }
  }

  async function updateTag(id: number, input: UpdateTagInput) {
    if (!lock('tags')) throw new Error('Another tag change is already in progress.');
    try {
      const tag = await request<Tag>(`/api/tags/${id}`, 'PUT', input);
      setTags(current => current.map(item => item.id === tag.id ? tag : item)
        .sort((a, b) => a.name.localeCompare(b.name)));
      setTodos(current => current.map(todo => ({
        ...todo,
        tags: todo.tags?.map(item => item.id === tag.id ? tag : item),
      })));
      setTagsError(null);
      setStatus(`Tag "${tag.name}" updated.`);
    } finally { unlock('tags'); }
  }

  async function deleteTag(id: number) {
    if (!lock('tags')) throw new Error('Another tag change is already in progress.');
    try {
      await request(`/api/tags/${id}`, 'DELETE');
      const removedTag = tags.find(tag => tag.id === id);
      setTags(current => current.filter(tag => tag.id !== id));
      setTodos(current => current.map(todo => ({
        ...todo,
        tags: todo.tags?.filter(tag => tag.id !== id),
      })));
      setFilters(current => current.tagId === id ? { ...current, tagId: 'all' } : current);
      setTagsError(null);
      setStatus(removedTag ? `Tag "${removedTag.name}" deleted.` : 'Tag deleted.');
    } finally { unlock('tags'); }
  }

  function applyPreset(preset: FilterPreset) {
    const tagId = preset.filters.tagId !== 'all' &&
      !tagsLoading && !tags.some(tag => tag.id === preset.filters.tagId)
      ? 'all' : preset.filters.tagId;
    setFilters({ ...preset.filters, tagId });
  }

  function clearFilters() {
    setFilters({ ...DEFAULT_FILTER_STATE });
  }

  function describeFilters(value: FilterState): string[] {
    const descriptions: string[] = [];
    if (value.search.trim()) descriptions.push(`Search: "${value.search.trim()}"`);
    if (value.priority !== 'all') descriptions.push(`Priority: ${value.priority}`);
    if (value.tagId !== 'all') descriptions.push(`Tag: ${tags.find(tag => tag.id === value.tagId)?.name ?? 'Removed tag'}`);
    if (value.completion !== 'all') descriptions.push(`Completion: ${value.completion}`);
    if (value.dueDateFrom || value.dueDateTo) {
      descriptions.push(`Date: ${value.dueDateFrom ?? 'any'} to ${value.dueDateTo ?? 'any'}`);
    }
    return descriptions;
  }

  function saveCurrentPreset(event: FormEvent) {
    event.preventDefault();
    setPresetError(null);
    try {
      const saved = savePreset({
        id: crypto.randomUUID(),
        name: presetName,
        filters,
        createdAt: toSingaporeISO(getSingaporeNow()),
      });
      setPresets(saved);
      setPresetName('');
      setSavingPreset(false);
      setStatus('Filter preset saved.');
    } catch (cause) {
      setPresetError(message(cause));
    }
  }

  function removePreset(preset: FilterPreset) {
    if (!window.confirm(`Delete the "${preset.name}" filter preset?`)) return;
    try {
      setPresets(deletePreset(preset.id));
      setStatus(`Filter preset "${preset.name}" deleted.`);
    } catch (cause) {
      setPresetError(message(cause));
    }
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

  return <main>
    <header className="row between">
      <div><h1>Todo planner</h1><p className="muted">Make room for what matters. Singapore time.</p></div>
      <button onClick={() => void logout()} disabled={pending.has('logout')}>Logout</button>
    </header>
    <section className="panel" aria-labelledby="new-todo">
      <div className="row between">
        <h2 id="new-todo">Add a todo</h2>
        <button type="button" onClick={() => setManagingTags(true)}>Manage Tags</button>
      </div>
      <TodoForm pending={pending.has('create')} onSave={input => save(input)} tags={tags} />
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
    <section className="panel" aria-label="Search and filters">
      <label htmlFor="todo-search">Search todos and subtasks
        <input id="todo-search" type="search" value={filters.search}
          placeholder="Search todos and subtasks..."
          onChange={event => setFilters(current => ({ ...current, search: event.target.value }))} />
      </label>
      {filters.search && <button type="button" aria-label="Clear search"
        onClick={() => setFilters(current => ({ ...current, search: '' }))}>Clear search</button>}
      <div className="fields">
        <label htmlFor="priority-filter">Priority
          <select id="priority-filter" value={filters.priority}
            onChange={event => setFilters(current => ({
              ...current,
              priority: priorities.find(priority => priority === event.target.value) ?? 'all',
            }))}>
            <option value="all">All Priorities</option>
            {priorities.map(priority => <option key={priority} value={priority}>
              {priority[0].toUpperCase() + priority.slice(1)}
            </option>)}
          </select>
        </label>
        {tags.length > 0 && <label htmlFor="tag-filter">Tag
          <select id="tag-filter" value={filters.tagId}
            onChange={event => setFilters(current => ({
              ...current, tagId: event.target.value === 'all' ? 'all' : Number(event.target.value),
            }))}>
            <option value="all">All Tags</option>
            {tags.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
          </select>
        </label>}
        <button type="button" aria-expanded={advancedFilters}
          aria-controls="advanced-filters" className={advancedFilters ? 'advanced active' : 'advanced'}
          onClick={() => setAdvancedFilters(value => !value)}>
          {advancedFilters ? '▼ Advanced' : '▶ Advanced'}
        </button>
      </div>
      {advancedFilters && <div id="advanced-filters" className="advanced-panel">
        <div className="fields">
          <label htmlFor="completion-filter">Completion status
            <select id="completion-filter" value={filters.completion}
              onChange={event => setFilters(current => ({
                ...current,
                completion: event.target.value as FilterState['completion'],
              }))}>
              <option value="all">All Todos</option>
              <option value="incomplete">Incomplete Only</option>
              <option value="completed">Completed Only</option>
            </select>
          </label>
          <label htmlFor="due-date-from">Due Date From
            <input id="due-date-from" type="date" value={filters.dueDateFrom ?? ''}
              onChange={event => setFilters(current => ({
                ...current, dueDateFrom: event.target.value || null,
              }))} />
          </label>
          <label htmlFor="due-date-to">Due Date To
            <input id="due-date-to" type="date" value={filters.dueDateTo ?? ''}
              onChange={event => setFilters(current => ({
                ...current, dueDateTo: event.target.value || null,
              }))} />
          </label>
        </div>
        {presets.length > 0 && <div className="preset-list" aria-label="Saved filter presets">
          <h3>Saved Filter Presets</h3>
          {presets.map(preset => <span className="preset-pill" key={preset.id}>
            <button type="button" onClick={() => applyPreset(preset)}>{preset.name}</button>
            <button type="button" aria-label={`Delete preset ${preset.name}`}
              onClick={() => removePreset(preset)}>×</button>
          </span>)}
        </div>}
      </div>}
      {hasActiveFilters(filters) && <div className="row filter-actions">
        <button type="button" className="danger" onClick={clearFilters}>Clear All</button>
        <button type="button" className="save-filter" onClick={() => {
          setPresetError(null);
          setSavingPreset(true);
        }}>Save Filter</button>
      </div>}
    </section>
    <p role="status" className="sr-only">{status}</p>
    {error && <div role="alert" className="error">{error}
      <button onClick={async () => {
        if (!lock('refresh')) return;
        try { await refresh(); setError(null); } catch (cause) { setError(message(cause)); }
        finally { unlock('refresh'); }
      }} disabled={pending.has('refresh')}>Retry loading todos</button>
    </div>}
    {loading ? <p role="status">Loading todos...</p> : !error && todos.length === 0
      ? <p>You have no todos yet.</p>
      : !error && filteredTodos.length === 0 ? <p role="status">No todos match your filters.</p> : null}
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
            {(todo.tags ?? []).map(tag => <TagPill key={tag.id} tag={tag}
              selected={filters.tagId === tag.id}
              actionLabel={`Filter todos by ${tag.name}`}
              onClick={() => setFilters(current => ({ ...current, tagId: tag.id }))} />)}
          </div>
          <hr />
          <Subtasks todo={todo} pending={pending.has(`todo-${todo.id}`)} onChange={changeSubtask} />
        </li>)}
      </ul>
    </section>)}
    {editing && <Modal title="Edit todo" pending={pending.has(`todo-${editing.id}`)} onClose={() => setEditing(null)}>
      <TodoForm existing={editing} pending={pending.has(`todo-${editing.id}`)}
        onSave={input => save(input, editing)} onCancel={() => setEditing(null)} tags={tags} />
    </Modal>}
    {managingTags && <ManageTagsModal tags={tags} loading={tagsLoading} error={tagsError}
      pending={pending.has('tags')} onClose={() => setManagingTags(false)}
      onCreate={createTag} onUpdate={updateTag} onDelete={deleteTag} />}
    {savingPreset && <Modal title="Save Filter Preset" onClose={() => {
      if (!pending.has('preset')) setSavingPreset(false);
    }} pending={pending.has('preset')}>
      <form onSubmit={saveCurrentPreset}>
        <p>Current filters: {describeFilters(filters).join(' · ')}</p>
        <label htmlFor="preset-name">Preset name
          <input id="preset-name" value={presetName} required
            onChange={event => setPresetName(event.target.value)} />
        </label>
        {presetError && <p role="alert" className="error">{presetError}</p>}
        <div className="row">
          <button type="submit" className="primary">Save</button>
          <button type="button" onClick={() => setSavingPreset(false)}>Cancel</button>
        </div>
      </form>
    </Modal>}
  </main>;
}
