import type { Priority, Tag, Todo } from '@/lib/db';

export type FilterPriority = Priority | 'all';
export type CompletionFilter = 'all' | 'incomplete' | 'completed';

export interface FilterState {
  search: string;
  priority: FilterPriority;
  tagId: number | 'all';
  completion: CompletionFilter;
  dueDateFrom: string | null;
  dueDateTo: string | null;
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: FilterState;
  createdAt: string;
}

export const DEFAULT_FILTER_STATE: FilterState = {
  search: '',
  priority: 'all',
  tagId: 'all',
  completion: 'all',
  dueDateFrom: null,
  dueDateTo: null,
};

const PRESETS_KEY = 'todo-app:filter-presets';
const priorities: Priority[] = ['high', 'medium', 'low'];
const completions: CompletionFilter[] = ['all', 'incomplete', 'completed'];

type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): PresetStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFilters(value: unknown): FilterState | null {
  if (!isRecord(value)) return null;
  const { search, priority, tagId, completion, dueDateFrom, dueDateTo } = value;
  if (typeof search !== 'string') return null;
  if (priority !== 'all' && !priorities.includes(priority as Priority)) return null;
  if (tagId !== 'all' && (!Number.isSafeInteger(tagId) || (tagId as number) < 1)) return null;
  if (typeof completion !== 'string' || !completions.includes(completion as CompletionFilter)) return null;
  if (dueDateFrom !== null && typeof dueDateFrom !== 'string') return null;
  if (dueDateTo !== null && typeof dueDateTo !== 'string') return null;

  return {
    search,
    priority: priority as FilterPriority,
    tagId: tagId as number | 'all',
    completion: completion as CompletionFilter,
    dueDateFrom: dueDateFrom as string | null,
    dueDateTo: dueDateTo as string | null,
  };
}

function isPreset(value: unknown): value is FilterPreset {
  if (!isRecord(value) || typeof value.id !== 'string' ||
      typeof value.name !== 'string' || typeof value.createdAt !== 'string') return false;
  return normalizeFilters(value.filters) !== null;
}

export function hasActiveFilters(filters: FilterState): boolean {
  return filters.search.trim() !== '' ||
    filters.priority !== 'all' ||
    filters.tagId !== 'all' ||
    filters.completion !== 'all' ||
    filters.dueDateFrom !== null ||
    filters.dueDateTo !== null;
}

export function applyFilters(todos: Todo[], filters: FilterState): Todo[] {
  let result = todos;

  const query = filters.search.trim().toLowerCase();
  if (query) {
    result = result.filter(todo =>
      todo.title.toLowerCase().includes(query) ||
      (todo.subtasks ?? []).some(subtask => subtask.title.toLowerCase().includes(query)),
    );
  }

  if (filters.priority !== 'all') {
    result = result.filter(todo => todo.priority === filters.priority);
  }

  if (filters.tagId !== 'all') {
    result = result.filter(todo =>
      (todo.tags ?? []).some((tag: Tag) => tag.id === filters.tagId),
    );
  }

  if (filters.completion === 'incomplete') {
    result = result.filter(todo => !todo.completed);
  } else if (filters.completion === 'completed') {
    result = result.filter(todo => todo.completed);
  }

  if (filters.dueDateFrom || filters.dueDateTo) {
    result = result.filter(todo => {
      if (!todo.due_date) return false;
      const dueDate = todo.due_date.slice(0, 10);
      return (!filters.dueDateFrom || dueDate >= filters.dueDateFrom) &&
        (!filters.dueDateTo || dueDate <= filters.dueDateTo);
    });
  }

  return result;
}

export function loadPresets(storage = browserStorage()): FilterPreset[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PRESETS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPreset).map(preset => ({
      ...preset,
      filters: normalizeFilters(preset.filters)!,
    })) : [];
  } catch {
    return [];
  }
}

export function savePreset(preset: FilterPreset, storage = browserStorage()): FilterPreset[] {
  if (!storage) throw new Error('Filter presets are unavailable in this environment.');
  const name = preset.name.trim();
  if (!name) throw new Error('Filter name is required.');
  const filters = normalizeFilters(preset.filters);
  if (!filters) throw new Error('Filter settings are invalid.');

  const presets = [...loadPresets(storage), { ...preset, name, filters }];
  try {
    storage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'QuotaExceededError') {
      throw new Error('Could not save preset — storage full.');
    }
    throw new Error('Could not save filter preset.');
  }
  return presets;
}

export function deletePreset(id: string, storage = browserStorage()): FilterPreset[] {
  if (!storage) throw new Error('Filter presets are unavailable in this environment.');
  const presets = loadPresets(storage).filter(preset => preset.id !== id);
  try {
    storage.setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch {
    throw new Error('Could not delete filter preset.');
  }
  return presets;
}
