import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { todoDB } from '@/lib/db';
import { apiError, readJSON } from '@/lib/api';
import { todoWriteError, validateCreateTodo, validatePriority } from '@/lib/todoValidation';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const requestedPriority = request.nextUrl.searchParams.get('priority');
    const priority = requestedPriority === null ? null : validatePriority(requestedPriority);
    const todos = todoDB.findAllByUser(session.userId);
    return NextResponse.json(priority ? todos.filter((todo) => todo.priority === priority) : todos);
  } catch (error) { return apiError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const input = validateCreateTodo(await readJSON(request));
    try {
      return NextResponse.json(todoDB.create({ ...input, user_id: session.userId }), { status: 201 });
    } catch (error) { todoWriteError(error); }
  } catch (error) { return apiError(error); }
}
