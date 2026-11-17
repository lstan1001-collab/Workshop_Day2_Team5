import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { todoDB } from '@/lib/db';
import { apiError, readJSON } from '@/lib/api';
import { todoWriteError, validateTodoId, validateUpdateTodo } from '@/lib/todoValidation';

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
    const input = validateUpdateTodo(await readJSON(request), existing);
    try {
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
