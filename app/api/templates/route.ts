import { NextRequest, NextResponse } from 'next/server';
import { apiError, readJSON } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { templateDB } from '@/lib/db';
import { validateCreateTemplate } from '@/lib/templateValidation';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    return NextResponse.json(templateDB.findAllByUser(session.userId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const input = validateCreateTemplate(await readJSON(request));
    return NextResponse.json(templateDB.create(session.userId, input), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
