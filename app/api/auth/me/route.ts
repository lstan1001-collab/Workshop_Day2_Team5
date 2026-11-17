import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { apiError } from '@/lib/api';

export async function GET() {
  try {
    const session = await getSession();
    return session
      ? NextResponse.json(session)
      : NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  } catch (error) { return apiError(error); }
}
