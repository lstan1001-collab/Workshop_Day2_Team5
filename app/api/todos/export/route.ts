import { NextRequest, NextResponse } from 'next/server';
import { ApiError, apiError } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { todoDB } from '@/lib/db';
import { toCsv, toExport } from '@/lib/dataTransfer';
import { getSingaporeNow, toSingaporeISO } from '@/lib/timezone';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const format = request.nextUrl.searchParams.get('format') ?? 'json';
    if (format !== 'json' && format !== 'csv') throw new ApiError('Format must be json or csv');
    const todos = todoDB.findAllWithRelations(session.userId);
    const now = getSingaporeNow();
    return new NextResponse(format === 'csv' ? toCsv(todos) : JSON.stringify(toExport(todos, now), null, 2), {
      headers: {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="todos-${toSingaporeISO(now).slice(0, 10)}.${format}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
