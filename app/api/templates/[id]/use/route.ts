import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { templateDB } from '@/lib/db';
import { templateDueDate, validateStoredTemplate, validateTemplateId } from '@/lib/templateValidation';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: 'Template not found' }, { status: 404 });

export async function POST(_request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const id = validateTemplateId((await params).id);
    const template = templateDB.findById(id, session.userId);
    if (!template) return notFound();
    validateStoredTemplate(template);
    const todo = templateDB.createTodoFromTemplate(id, session.userId, templateDueDate(template));
    return todo ? NextResponse.json(todo, { status: 201 }) : notFound();
  } catch (error) {
    return apiError(error);
  }
}
