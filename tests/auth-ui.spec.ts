import { expect, test, type Page } from '@playwright/test';

async function mockAuth(page: Page) {
  const state = {
    signedIn: false,
    meStatus: 200,
    logoutStatus: 204,
    verifyStatus: 200,
    registerStatus: 200,
    credentialId: '',
    requests: [] as { path: string; body: Record<string, unknown> | null }[],
  };
  await page.route('**/api/auth/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/').pop()!;
    const body = request.method() === 'POST'
      ? request.postDataJSON() as Record<string, unknown> : null;
    state.requests.push({ path, body });
    const json = (status: number, payload: unknown) => route.fulfill({ status, json: payload });
    if (path === 'me') {
      if (state.meStatus !== 200) return json(state.meStatus, { error: 'Session service unavailable' });
      return state.signedIn ? json(200, { userId: 1, username: 'alice' })
        : json(401, { error: 'Not authenticated' });
    }
    if (path === 'logout') {
      if (state.logoutStatus !== 204) return json(state.logoutStatus, { error: 'Could not sign out' });
      state.signedIn = false;
      return route.fulfill({ status: 204 });
    }
    if (path === 'register-options' || path === 'add-passkey-options') {
      if (state.registerStatus !== 200) return json(state.registerStatus, { error: 'Username already taken' });
      return json(200, {
        challenge: 'dGVzdC1yZWdpc3RyYXRpb24tY2hhbGxlbmdl',
        rp: { id: 'localhost', name: 'Todo App UI Tests' },
        user: { id: 'YWxpY2U', name: 'alice', displayName: 'alice' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        attestation: 'none',
        timeout: 10000,
      });
    }
    if (path === 'login-options') {
      return json(200, {
        challenge: 'dGVzdC1hdXRoZW50aWNhdGlvbi1jaGFsbGVuZ2U',
        rpId: 'localhost',
        allowCredentials: [{ id: state.credentialId, type: 'public-key', transports: ['usb'] }],
        userVerification: 'required',
        timeout: 10000,
      });
    }
    if (path.endsWith('-verify')) {
      if (state.verifyStatus !== 200) return json(state.verifyStatus, { error: 'Verification failed' });
      const credential = body?.response as { id: string };
      state.credentialId = credential.id;
      state.signedIn = true;
      return json(200, { success: true });
    }
    return json(404, { error: 'Unexpected test endpoint' });
  });
  return state;
}

async function virtualAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

test('validates username, supports keyboard login controls, and shows duplicate-name errors', async ({ page }) => {
  const state = await mockAuth(page);
  state.registerStatus = 409;
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Enter a username.');
  await expect(page.getByLabel('Username', { exact: true })).toBeFocused();
  expect(state.requests.filter(item => item.path !== 'me')).toHaveLength(0);
  await page.getByLabel('Username', { exact: true }).fill(' alice ');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Username already taken');
  expect(state.requests.find(item => item.path === 'register-options')?.body).toEqual({ username: 'alice' });
  await expect(page).toHaveURL('/login');
});

test('registers, adds another passkey, logs out, logs in, and retains session on reload', async ({ page }) => {
  const state = await mockAuth(page);
  await virtualAuthenticator(page);
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText('Signed in as')).toContainText('alice');
  expect(state.requests.find(item => item.path === 'register-verify')?.body).toHaveProperty('response.response.attestationObject');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByRole('status')).toContainText('Passkey added.');
  expect(state.requests.find(item => item.path === 'add-passkey-verify')?.body).toHaveProperty('response.id');
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page).toHaveURL('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByLabel('Username', { exact: true }).press('Enter');
  await expect(page).toHaveURL('/');
  expect(state.requests.find(item => item.path === 'login-verify')?.body).toHaveProperty('response.response.signature');
  await page.reload();
  await expect(page.getByText('Signed in as')).toContainText('alice');
  await page.goto('/login');
  await expect(page).toHaveURL('/');
});

test('keeps the form pending through verification, prevents duplicate requests, and does not redirect on failure', async ({ page }) => {
  const state = await mockAuth(page);
  await virtualAuthenticator(page);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/register-verify', async route => {
    await gate;
    await route.fulfill({ status: 401, json: { error: 'Verification failed' } });
  });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByRole('button', { name: 'Register', exact: true }).dblclick();
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeDisabled();
  expect(state.requests.filter(item => item.path === 'register-options')).toHaveLength(1);
  await expect(page).toHaveURL('/login');
  release();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Verification failed');
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('alice');
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeEnabled();
  await expect(page).toHaveURL('/login');
});

test('treats a cancelled prompt as retryable feedback without clearing the username', async ({ page }) => {
  await mockAuth(page);
  await page.addInitScript(() => {
    navigator.credentials.create = async () => { throw new DOMException('Cancelled', 'NotAllowedError'); };
  });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('cancelled or timed out');
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('alice');
  await expect(page.getByRole('button', { name: 'Register', exact: true })).toBeEnabled();
});

test('explains unsupported passkeys without sending options requests', async ({ page }) => {
  const state = await mockAuth(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined });
  });
  await page.goto('/login');
  await page.getByLabel('Username', { exact: true }).fill('alice');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText("doesn't support passkeys");
  expect(state.requests.filter(item => item.path !== 'me')).toHaveLength(0);
});

test('shows session failures with retry and keeps logout failures on the account page', async ({ page }) => {
  const state = await mockAuth(page);
  state.meStatus = 503;
  await page.goto('/login');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Session service unavailable');
  state.meStatus = 200;
  state.signedIn = true;
  await page.getByRole('button', { name: 'Retry session check' }).click();
  await expect(page).toHaveURL('/');
  state.logoutStatus = 500;
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Could not sign out');
  await expect(page.getByRole('button', { name: 'Logout', exact: true })).toBeEnabled();
  await expect(page).toHaveURL('/');
});

test('redirects an unauthenticated account view and fits a narrow screen', async ({ page }) => {
  await mockAuth(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
