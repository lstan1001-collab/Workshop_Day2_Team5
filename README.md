# Phase 5: authentication

This workspace implements SQLite persistence, Next.js auth routes, and the authentication UI for
[PRP 11: WebAuthn authentication](https://github.com/kenken64/AI-SDLC-Workshop-Day1n2/blob/low-token-usage/PRPs/11-authentication-webauthn.md).
Todo features from Phases 1-4 are not implemented.

Requires Node.js 20+ (Node.js 24 LTS recommended).

```powershell
npm install
npm run test:db
npm run test:auth
npm run typecheck
npm run build
npx playwright install chromium
npm run test:ui
npm run dev
```

`lib/db.ts` exports synchronous `userDB`, `authenticatorDB`, `registrationDB`,
and `challengeStore` operations. The database defaults to `todos.db` in the
project root; set `DATABASE_PATH` to an existing directory's file path to override it.
Database files, credentials, and dependencies are excluded from Git.
Initialisation adds the authentication tables without deleting existing tables or data.
Concurrent startup retries transient SQLite lock errors during the WAL journal-mode
switch for up to five seconds; persistent locks and other errors are still reported.

## Backend integration

- `registrationDB.create(username, { credential_id, credential_public_key, counter? })`
  atomically creates the user and first authenticator. Call it only after successful
  WebAuthn registration verification. SQLite uniqueness errors must become a 409 response.
- `authenticatorDB.create(userId, input)` adds another passkey, but the route must
  first authenticate the existing account owner. A username alone is not authorization.
- Login must use `findByCredentialIdForUser(credentialId, userId)` so a valid
  credential for a different account cannot authenticate the supplied username.
- `authenticatorDB.updateCounter(id, newCounter ?? 0)` rejects repeated or regressing
  nonzero counters. Repeated zero counters are supported. WebAuthn signature/origin/RP
  verification remains the route's responsibility.
- `challengeStore.save(id, username, purpose, challenge)` stores a five-minute
  challenge. Use a fresh cryptographically random ID held in an HTTP-only cookie,
  binding the request to its browser; never use the username as the ID.
  Purpose is `registration` or `authentication`.
- `challengeStore.consume(id, username, purpose)` atomically removes the challenge
  and returns it only if unexpired and matching the account and purpose. A missing,
  expired, mismatched, or already-consumed challenge returns `undefined`; reject
  verification in that case. Consume before verifying the browser response; retries
  after a failed verification need fresh options. Different browser requests use
  different IDs and do not overwrite each other's challenges.

Credentials use canonical base64url IDs and binary public keys; no passwords or
private keys are stored. Server sessions, auth API routes, middleware, and
virtual-authenticator integration tests are present.
There is no account-recovery mechanism if all registered passkeys are lost.

## Frontend integration

`/login` supports username-only registration/login, passkey prompts, retryable
cancellation, accessible feedback, and duplicate-submission protection.
`/` is an authentication-only account view with Logout and Add passkey controls.
The client session check is only a UX aid; it does not replace server authorization
or the middleware required by the PRP. `/calendar` is not implemented here.

`lib/auth-client.ts` expects these JSON contracts:

- `GET /api/auth/me`: `{ "userId": 1, "username": "alice" }`, or 401.
  The values shown are examples. Responses are not cached.
- `POST /api/auth/register-options` and `/login-options`: `{ username }` request,
  SimpleWebAuthn JSON options response.
- `POST /api/auth/register-verify` and `/login-verify`:
  `{ username, response }` request; successful verification must set the session
  cookie before returning 2xx with JSON, or 204.
- `POST /api/auth/logout`: `{}` request; 2xx JSON or 204 after clearing the cookie.
- Approved second-passkey extension: session-protected
  `POST /api/auth/add-passkey-options` accepts `{}` and returns registration options;
  `/api/auth/add-passkey-verify` accepts `{ response }`. The server must determine
  the owner from the existing session, not a supplied username.
- Failures: non-2xx with `{ "error": "Readable message" }`.

Passkeys require HTTPS in deployment (localhost is allowed during development).
The UI never reads the HTTP-only session cookie or handles a private key.
Set `AUTH_SECRET` to at least 32 random characters before running the server.
`WEBAUTHN_RP_ID` defaults to `localhost` and `WEBAUTHN_ORIGIN` defaults to
`http://localhost:3105`; set both for your actual server address.
Never commit the secret or application database.

`npm run test:ui` starts a temporary server on port 3105. `auth-ui.spec.ts`
uses mock API responses for frontend contract tests;
`01-authentication.spec.ts` uses real routes with Chromium virtual authenticators.
Use a temporary `DATABASE_PATH` for integration tests to avoid adding test users
to the application database. Physical-device authentication is not covered.

The database supports request-specific challenge IDs, but the current routes use
username-derived IDs. Browser-bound, random request IDs still require backend
integration; do not treat the database's support alone as end-to-end protection.
