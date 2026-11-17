import { NextRequest, NextResponse } from 'next/server';
import { apiError, readJSON } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { todoDB } from '@/lib/db';
import { validateImport } from '@/lib/dataTransfer';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const payload = validateImport(await readJSON(request, 'Invalid JSON format'));
    return NextResponse.json({ success: true, ...todoDB.importAll(session.userId, payload.todos) });
  } catch (error) {
    return apiError(error);
  }
}
