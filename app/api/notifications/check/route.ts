import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { todoDB } from '@/lib/db';
import { getSingaporeNow, toSingaporeISO } from '@/lib/timezone';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const now = toSingaporeISO(getSingaporeNow());
  return NextResponse.json({
    success: true,
    data: todoDB.findDueReminders(session.userId, now),
  });
}
