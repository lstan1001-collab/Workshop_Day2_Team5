import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('registers, adds a second passkey, and signs in with it against the real API', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const options = {
    protocol: 'ctap2' as const, transport: 'internal' as const, hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  };
  const first = await cdp.send('WebAuthn.addVirtualAuthenticator', { options });
  const username = `auth-test-${randomBytes(8).toString('hex')}`;
  await page.goto('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page).toHaveURL('/');

  await cdp.send('WebAuthn.removeVirtualAuthenticator', first);
  const second = await cdp.send('WebAuthn.addVirtualAuthenticator', { options });
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await expect(page.getByText('Passkey added.')).toBeVisible();
  expect((await cdp.send('WebAuthn.getCredentials', second)).credentials).toHaveLength(1);

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page).toHaveURL('/login');
  await page.getByLabel('Username').fill(username);
  await page.getByRole('button', { name: 'Login' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Todo planner' })).toBeVisible();
});
