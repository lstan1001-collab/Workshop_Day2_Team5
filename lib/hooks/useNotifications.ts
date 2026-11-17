'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Todo } from '@/lib/db';
import { formatSingaporeDate, getSingaporeNow } from '@/lib/timezone';

type Permission = NotificationPermission | 'unsupported' | 'loading';

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  if (response.status === 401) throw new Error('Your session expired. Sign in again to receive reminders.');
  const body = await response.json();
  throw new Error(typeof body.error === 'string' ? body.error : 'Could not update reminders');
}

export function useNotifications() {
  const [permission, setPermission] = useState<Permission>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => setPermission('Notification' in window ? Notification.permission : 'unsupported');
    sync();
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) return;
    try {
      setError(null);
      setPermission(await Notification.requestPermission());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not request notification permission');
    }
  }, []);

  useEffect(() => {
    if (permission !== 'granted') return;
    const controller = new AbortController();
    let active = true;
    let polling = false;
    // Keep successfully displayed reminders until their server acknowledgement succeeds.
    const displayed = new Map<number, { window: string; sentAt: string }>();

    const poll = async () => {
      if (polling || !active) return;
      if (Notification.permission !== 'granted') {
        setPermission(Notification.permission);
        return;
      }
      polling = true;
      try {
        const response = await fetch('/api/notifications/check', { signal: controller.signal, cache: 'no-store' });
        await checkResponse(response);
        const { data }: { data: Todo[] } = await response.json();
        for (const todo of data) {
          if (!active || Notification.permission !== 'granted') break;
          const windowKey = `${todo.due_date}:${todo.reminder_minutes}`;
          const previous = displayed.get(todo.id);
          const sentAt = previous?.window === windowKey ? previous.sentAt : getSingaporeNow().toISOString();
          if (previous?.window !== windowKey) {
            new Notification(todo.title, {
              body: todo.due_date ? `Due ${formatSingaporeDate(todo.due_date)} (Singapore)` : todo.title,
              tag: `todo-${todo.id}`,
            });
            displayed.set(todo.id, { window: windowKey, sentAt });
          }
          const marked = await fetch(`/api/todos/${todo.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ last_notification_sent: sentAt }),
            signal: controller.signal,
          });
          await checkResponse(marked);
        }
        if (active) setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not check reminders');
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 30_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [permission]);

  return { permission, error, requestPermission };
}
