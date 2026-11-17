import { NextRequest, NextResponse } from 'next/server';
import { ApiError, apiError, readJSON } from '@/lib/api';
import { getSession } from '@/lib/auth';
import { tagDB } from '@/lib/db';
import { validateTagId, validateUpdateTag } from '@/lib/tagValidation';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

const notFound = () => NextResponse.json({ error: 'Tag not found' }, { status: 404 });

export async function PUT(request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const id = validateTagId((await params).id);
    if (!tagDB.findById(id, session.userId)) return notFound();
    const input = validateUpdateTag(await readJSON(request));

    try {
      const tag = tagDB.update(id, session.userId, input);
      return tag ? NextResponse.json(tag) : notFound();
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

export async function DELETE(_request: NextRequest, { params }: Context) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    const id = validateTagId((await params).id);
    return tagDB.delete(id, session.userId)
      ? NextResponse.json({ success: true })
      : notFound();
  } catch (error) {
    return apiError(error);
  }
}
