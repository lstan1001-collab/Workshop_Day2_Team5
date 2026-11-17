import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createSessionToken, verifySessionToken, parseUsername } from '../lib/auth';

const SECRET = 'test-secret-that-is-long-enough-1234567890';

function withSecret(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env.AUTH_SECRET;
  if (value === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = value;
  return run().finally(() => {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  });
}

test('session token round-trips the user id and username', () => withSecret(SECRET, async () => {
  const token = await createSessionToken({ userId: 7, username: 'alice' });
  assert.deepEqual(await verifySessionToken(token), { userId: 7, username: 'alice' });
}));

test('rejects a token whose payload was altered', () => withSecret(SECRET, async () => {
  const token = await createSessionToken({ userId: 7, username: 'alice' });
  const [header, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ userId: 8, username: 'bob', iat: 1, exp: 9999999999 }))
    .toString('base64url');
  assert.equal(await verifySessionToken(`${header}.${forged}.${signature}`), null);
}));

test('rejects an expired token', () => withSecret(SECRET, async () => {
  const expired = await new SignJWT({ userId: 7, username: 'alice' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(new TextEncoder().encode(SECRET));
  assert.equal(await verifySessionToken(expired), null);
}));

test('fails closed when AUTH_SECRET is missing or short', () => withSecret(undefined, async () => {
  await assert.rejects(createSessionToken({ userId: 7, username: 'alice' }), /AUTH_SECRET/);
  assert.equal(await verifySessionToken('a.b.c'), null);
  await withSecret('too-short', async () => {
    await assert.rejects(createSessionToken({ userId: 7, username: 'alice' }), /AUTH_SECRET/);
  });
}));

test('parseUsername trims and bounds the length', () => {
  assert.equal(parseUsername('  alice  '), 'alice');
  assert.equal(parseUsername('   '), null);
  assert.equal(parseUsername('a'.repeat(65)), null);
  assert.equal(parseUsername(42), null);
});
