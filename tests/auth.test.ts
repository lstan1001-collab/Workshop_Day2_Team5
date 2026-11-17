import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { signSession, verifySession } from '@/lib/auth';

beforeEach(() => {
  vi.stubEnv('JWT_SECRET', 'test-only-secret-with-at-least-32-bytes');
});

describe('JWT sessions', () => {
  it('round-trips an authenticated identity and rejects tampering', async () => {
    const token = await signSession({ id: 7, username: 'test-user' });
    expect(await verifySession(token)).toEqual({ userId: 7, username: 'test-user' });
    expect(await verifySession(`${token.slice(0, -8)}tampered`)).toBeNull();
    expect(await verifySession(undefined)).toBeNull();
  });

  it('rejects expired or incomplete tokens', async () => {
    const key = new TextEncoder().encode(process.env.JWT_SECRET);
    const expired = await new SignJWT({ userId: 7, username: 'test-user' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('todo-app').setAudience('todo-app')
      .setIssuedAt().setExpirationTime('1s').sign(key);
    vi.useFakeTimers();
    vi.advanceTimersByTime(2000);
    expect(await verifySession(expired)).toBeNull();
    vi.useRealTimers();
    const incomplete = await new SignJWT({ userId: 7 })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer('todo-app').setAudience('todo-app')
      .setIssuedAt().setExpirationTime('7d').sign(key);
    expect(await verifySession(incomplete)).toBeNull();
  });

  it('fails explicitly when the signing secret is missing', async () => {
    vi.stubEnv('JWT_SECRET', '');
    await expect(signSession({ id: 1, username: 'test-user' })).rejects.toThrow('JWT_SECRET');
  });
});
