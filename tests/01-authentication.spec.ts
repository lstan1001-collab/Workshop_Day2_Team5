import { expect, test, type Page } from '@playwright/test';

// Runs against the real Next.js server (no route mocks) with a CDP virtual authenticator.
async function useVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    credentialCount: async () =>
      (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials.length,
  };
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test('protects the home page until a passkey session exists', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  const me = await page.request.get('/api/auth/me');
  expect(me.status()).toBe(401);
});

test('registers, logs out, and logs back in with the passkey', async ({ page }) => {
  await useVirtualAuthenticator(page);
  const username = uniqueName('alice');

  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page).toHaveURL('/');
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);

  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL('/');
  const me = await (await page.request.get('/api/auth/me')).json();
  expect(me.username).toBe(username);
});

test('rejects a duplicate username and an unknown login', async ({ page }) => {
  await useVirtualAuthenticator(page);
  const username = uniqueName('bob');
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page).toHaveURL('/');

  const duplicate = await page.request.post('/api/auth/register-options', { data: { username } });
  expect(duplicate.status()).toBe(409);

  const unknown = await page.request.post('/api/auth/login-options', { data: { username: uniqueName('nobody') } });
  expect(unknown.status()).toBe(404);
});

test('adds a second passkey on a different authenticator while signed in', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const authenticatorOptions = {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  } as const;
  const first = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticatorOptions });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill(uniqueName('carol'));
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page).toHaveURL('/');

  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: first.authenticatorId });
  const second = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: authenticatorOptions });
  const verified = page.waitForResponse(response =>
    response.url().endsWith('/api/auth/add-passkey-verify'));
  await page.getByRole('button', { name: 'Add passkey' }).click();
  expect((await verified).status()).toBe(204);
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId: second.authenticatorId,
  });
  expect(credentials).toHaveLength(1);
});

test('ignores a forged session cookie', async ({ page, context }) => {
  await context.addCookies([{
    name: 'session', value: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjF9.bogus',
    url: 'http://localhost:3105',
  }]);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get('/api/auth/me')).status()).toBe(401);
});
