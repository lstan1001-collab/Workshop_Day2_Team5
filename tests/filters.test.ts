import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilterPreset, FilterState } from '@/lib/filters';
import { applyFilters, DEFAULT_FILTER_STATE, deletePreset, hasActiveFilters, loadPresets, savePreset } from '@/lib/filters';
import type { Tag, Todo } from '@/lib/db';

const workTag: Tag = {
  id: 1, user_id: 1, name: 'Work', color: '#123456', created_at: '2026-11-17T10:00:00+08:00',
};

const todos: Todo[] = [
  {
    id: 1, user_id: 1, title: 'Team meeting', completed: false,
    due_date: '2026-11-18T10:00:00+08:00', priority: 'high',
    is_recurring: false, recurrence_pattern: null, reminder_minutes: null,
    last_notification_sent: null, created_at: '2026-11-17T10:00:00+08:00',
    updated_at: null, subtasks: [], tags: [workTag],
  },
  {
    id: 2, user_id: 1, title: 'Planning', completed: true,
    due_date: '2026-11-20T10:00:00+08:00', priority: 'medium',
    is_recurring: false, recurrence_pattern: null, reminder_minutes: null,
    last_notification_sent: null, created_at: '2026-11-17T10:00:00+08:00',
    updated_at: null, subtasks: [{ id: 2, todo_id: 2, title: 'Send report', completed: false,
      position: 0, created_at: '2026-11-17T10:00:00+08:00' }], tags: [],
  },
  {
    id: 3, user_id: 1, title: 'No due date', completed: false, due_date: null,
    priority: 'low', is_recurring: false, recurrence_pattern: null, reminder_minutes: null,
    last_notification_sent: null, created_at: '2026-11-17T10:00:00+08:00',
    updated_at: null, subtasks: [], tags: [],
  },
];

function filters(overrides: Partial<FilterState> = {}): FilterState {
  return { ...DEFAULT_FILTER_STATE, ...overrides };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

afterEach(() => vi.useRealTimers());

describe('applyFilters', () => {
  it('searches todo and subtask titles with case-insensitive partial matching', () => {
    expect(applyFilters(todos, filters({ search: 'MEET' })).map(todo => todo.id)).toEqual([1]);
    expect(applyFilters(todos, filters({ search: 'REPORT' })).map(todo => todo.id)).toEqual([2]);
    expect(applyFilters(todos, filters({ search: '   ' }))).toEqual(todos);
    expect(applyFilters(todos, filters({ search: 'missing' }))).toEqual([]);
  });

  it('applies priority, tag, and completion filters', () => {
    expect(applyFilters(todos, filters({ priority: 'high' })).map(todo => todo.id)).toEqual([1]);
    expect(applyFilters(todos, filters({ tagId: workTag.id })).map(todo => todo.id)).toEqual([1]);
    expect(applyFilters(todos, filters({ completion: 'completed' })).map(todo => todo.id)).toEqual([2]);
    expect(applyFilters(todos, filters({ completion: 'incomplete' })).map(todo => todo.id)).toEqual([1, 3]);
  });

  it('filters date bounds independently, excludes undated todos, and combines all dimensions with AND', () => {
    expect(applyFilters(todos, filters({ dueDateFrom: '2026-11-19' })).map(todo => todo.id)).toEqual([2]);
    expect(applyFilters(todos, filters({ dueDateTo: '2026-11-18' })).map(todo => todo.id)).toEqual([1]);
    expect(applyFilters(todos, filters({ dueDateFrom: '2026-11-21', dueDateTo: '2026-11-18' }))).toEqual([]);
    expect(applyFilters(todos, filters({
      search: 'meeting', priority: 'high', tagId: workTag.id,
      completion: 'incomplete', dueDateFrom: '2026-11-18', dueDateTo: '2026-11-18',
    })).map(todo => todo.id)).toEqual([1]);
  });
});

describe('filter presets', () => {
  it('detects active filter dimensions and ignores whitespace-only search', () => {
    expect(hasActiveFilters(DEFAULT_FILTER_STATE)).toBe(false);
    expect(hasActiveFilters(filters({ search: '  ' }))).toBe(false);
    const activeFilters: Partial<FilterState>[] = [
      { search: 'x' }, { priority: 'high' }, { tagId: 1 },
      { completion: 'completed' }, { dueDateFrom: '2026-01-01' }, { dueDateTo: '2026-01-01' },
    ];
    for (const active of activeFilters) expect(hasActiveFilters(filters(active))).toBe(true);
  });

  it('round-trips saved filters, rejects malformed storage safely, and deletes presets', () => {
    const storage = memoryStorage();
    const preset: FilterPreset = {
      id: 'preset-1', name: '  Work  ',
      filters: filters({ search: 'meeting', priority: 'high', tagId: 1 }),
      createdAt: '2026-11-17T10:00:00+08:00',
    };
    expect(savePreset(preset, storage)).toMatchObject([{ name: 'Work' }]);
    expect(loadPresets(storage)[0]).toMatchObject({ name: 'Work', filters: preset.filters });
    expect(deletePreset('preset-1', storage)).toEqual([]);
    storage.setItem('todo-app:filter-presets', '{bad json');
    expect(loadPresets(storage)).toEqual([]);
  });

  it('surfaces quota errors instead of silently losing a preset', () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
    expect(() => savePreset({
      id: 'preset-2', name: 'Daily', filters: filters(), createdAt: 'now',
    }, storage)).toThrow('storage full');
  });
});
