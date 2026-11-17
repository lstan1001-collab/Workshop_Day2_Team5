import { NextRequest, NextResponse } from 'next/server';
import { ApiError, apiError, readJSON } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { tagDB } from '@/lib/db';
import { validateCreateTag } from '@/lib/tagValidation';

export const runtime = 'nodejs';

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    return NextResponse.json(tagDB.findAllByUser(session.userId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const input = validateCreateTag(await readJSON(request));

    try {
      return NextResponse.json(tagDB.create(session.userId, input), { status: 201 });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new ApiError('A tag with this name already exists', 409);
      }
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}
