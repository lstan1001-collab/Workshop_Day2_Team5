import { NextRequest, NextResponse } from 'next/server';
import { ApiError, apiError } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { holidayDB } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const year = request.nextUrl.searchParams.get('year');
    const month = request.nextUrl.searchParams.get('month');
    if (year === null && month === null) return NextResponse.json({ holidays: holidayDB.findAll() });
    if (year === null || month === null || !/^\d{4}$/.test(year) ||
      !/^(0?[1-9]|1[0-2])$/.test(month)) {
      throw new ApiError('Provide a valid year and month together');
    }
    return NextResponse.json({ holidays: holidayDB.findByMonth(Number(year), Number(month)) });
  } catch (error) {
    return apiError(error);
  }
}
