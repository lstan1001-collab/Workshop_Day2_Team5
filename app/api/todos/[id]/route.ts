import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { todoDB } from '@/lib/db';
import { apiError, readJSON } from '@/lib/api';
import { calculateNextDueDate } from '@/lib/recurrence';
import { getSingaporeNow, toSingaporeISO } from '@/lib/timezone';
import {
  todoWriteError,
  validateReminderTimestamp,
  validateTodoId,
  validateUpdateTodo,
} from '@/lib/todoValidation';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: 'Todo not found' }, { status: 404 });
const unauthenticated = () => NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

export async function GET(_request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return unauthenticated();
    const id = validateTodoId((await params).id);
    const todo = todoDB.findById(id, session.userId);
    return todo ? NextResponse.json(todo) : notFound();
  } catch (error) { return apiError(error); }
}

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return unauthenticated();
    const id = validateTodoId((await params).id);
    const existing = todoDB.findById(id, session.userId);
    if (!existing) return notFound();
    const body = await readJSON(request);
    if (
      typeof body === 'object' &&
      body !== null &&
      Object.prototype.hasOwnProperty.call(body, 'last_notification_sent')
    ) {
      if (Object.keys(body).length !== 1) {
        return NextResponse.json(
          { error: 'Reminder timestamps must be updated separately' },
          { status: 400 },
        );
      }
      validateReminderTimestamp((body as Record<string, unknown>).last_notification_sent);
      const now = toSingaporeISO(getSingaporeNow());
      const updated = todoDB.markReminderSent(id, session.userId, now);
      return updated ? NextResponse.json(updated) : notFound();
    }

    const input = validateUpdateTodo(body, existing);
    try {
      if (input.completed === true && !existing.completed) {
        const result = todoDB.completeAndCreateNext(
          id,
          session.userId,
          input,
          calculateNextDueDate,
        );
        if (!result.todo) return notFound();
        return result.nextInstance
          ? NextResponse.json(result)
          : NextResponse.json(result.todo);
      }
      const updated = todoDB.update(id, session.userId, input);
      return updated ? NextResponse.json(updated) : notFound();
    } catch (error) { todoWriteError(error); }
  } catch (error) { return apiError(error); }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return unauthenticated();
    const id = validateTodoId((await params).id);
    return todoDB.delete(id, session.userId)
      ? NextResponse.json({ success: true }) : notFound();
  } catch (error) { return apiError(error); }
}
