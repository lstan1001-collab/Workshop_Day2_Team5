import { NextRequest, NextResponse } from 'next/server';
import { apiError, readJSON } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { tagDB, todoDB } from '@/lib/db';
import { validateTagLink } from '@/lib/tagValidation';
import { validateTodoId } from '@/lib/todoValidation';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const notFound = () => NextResponse.json({ error: 'Todo or tag not found' }, { status: 404 });

async function getOwnedIds(
  params: Promise<{ id: string }>,
  body: unknown,
  userId: number,
): Promise<{ todoId: number; tagId: number } | null> {
  const todoId = validateTodoId((await params).id);
  const { tag_id: tagId } = validateTagLink(body);
  if (!todoDB.findById(todoId, userId) || !tagDB.findById(tagId, userId)) return null;
  return { todoId, tagId };
}

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const owned = await getOwnedIds(params, await readJSON(request), session.userId);
    if (!owned) return notFound();
    tagDB.attachToTodo(owned.todoId, owned.tagId, session.userId);
    return NextResponse.json({
      success: true,
      tags: tagDB.findByTodoId(owned.todoId, session.userId),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const owned = await getOwnedIds(params, await readJSON(request), session.userId);
    if (!owned) return notFound();
    tagDB.detachFromTodo(owned.todoId, owned.tagId, session.userId);
    return NextResponse.json({
      success: true,
      tags: tagDB.findByTodoId(owned.todoId, session.userId),
    });
  } catch (error) {
    return apiError(error);
  }
}
