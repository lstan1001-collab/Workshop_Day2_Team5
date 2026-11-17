import { NextRequest, NextResponse } from 'next/server';
import { apiError, readJSON } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { templateDB } from '@/lib/db';
import { validateTemplateId, validateUpdateTemplate } from '@/lib/templateValidation';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: 'Template not found' }, { status: 404 });

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const id = validateTemplateId((await params).id);
    const existing = templateDB.findById(id, session.userId);
    if (!existing) return notFound();
    const input = validateUpdateTemplate(await readJSON(request), existing);
    const template = templateDB.update(id, session.userId, input);
    return template ? NextResponse.json(template) : notFound();
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const id = validateTemplateId((await params).id);
    return templateDB.delete(id, session.userId)
      ? NextResponse.json({ success: true })
      : notFound();
  } catch (error) {
    return apiError(error);
  }
}
