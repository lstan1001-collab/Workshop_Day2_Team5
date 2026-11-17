import { NextResponse } from 'next/server';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export async function readJSON(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError('Content-Type must be application/json', 415);
  }
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApiError('Invalid JSON');
    throw error;
  }
}

export function apiError(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  console.error('API request failed', error instanceof Error ? error.name : 'UnknownError');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
