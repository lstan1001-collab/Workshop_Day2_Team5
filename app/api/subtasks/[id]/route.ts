import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSession } from '@/lib/auth';
import { apiError, readJSON } from '@/lib/api';
import { subtaskDB } from '@/lib/db';
import { validateTodoId } from '@/lib/todoValidation';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: 'Subtask not found' }, { status: 404 });
const updateSchema = z.strictObject({
  title: z.string().trim().min(1, 'Subtask title is required').optional(),
  completed: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one subtask field must be provided',
});

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const id = validateTodoId((await params).id);
    const input = updateSchema.parse(await readJSON(request));
    const updated = subtaskDB.update(id, session.userId, input);
    return updated ? NextResponse.json(updated) : notFound();
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    const id = validateTodoId((await params).id);
    return subtaskDB.delete(id, session.userId)
      ? NextResponse.json({ success: true })
      : notFound();
  } catch (error) { return apiError(error); }
}
