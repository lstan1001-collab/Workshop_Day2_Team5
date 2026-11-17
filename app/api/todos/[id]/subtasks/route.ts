import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { apiError, readJSON } from '@/lib/api';
import { subtaskDB } from '@/lib/db';
import { validateTodoId } from '@/lib/todoValidation';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const todoId = validateTodoId((await params).id);
    const body = z.strictObject({
      title: z.string().trim().min(1, 'Subtask title is required'),
    }).parse(await readJSON(_request));
    const subtask = subtaskDB.create(todoId, session.userId, body);
    if (!subtask) {
      return NextResponse.json({ error: 'Todo not found' }, { status: 404 });
    }
    return NextResponse.json(subtask, { status: 201 });
  } catch (error) { return apiError(error); }
}
