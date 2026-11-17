import { NextResponse } from 'next/server';
import { deleteSession } from '@/lib/auth';
import { apiError } from '@/lib/api';

export async function POST() {
  try {
    await deleteSession();
    return NextResponse.json({ success: true });
  } catch (error) { return apiError(error); }
}
