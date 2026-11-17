# Backend contract

The app runs on the Next.js Node.js runtime, with SQLite in `todos.db`.
Run `npm install`, copy `.env.example` to `.env.local`, and replace `JWT_SECRET`
with at least 32 cryptographically random bytes. Never commit `.env.local`.
Configure `RP_ID` and `RP_ORIGIN` for the deployment hostname and HTTPS origin.
Passkeys work on HTTPS or localhost. Production cookies require HTTPS.

Authentication uses the documented options/verify endpoints with
`{ username }` and `{ username, response }` request bodies, respectively.
`response` is the result from `@simplewebauthn/browser`.
`GET /api/auth/me` returns `{ userId, username }`; logout is a POST.
Sessions are HTTP-only, SameSite=Lax cookies with a seven-day expiry.
WebAuthn challenges are browser-bound, single-use, and expire after five minutes.
The challenge store is process-local: restarting the server requires retrying
login/registration. Deploy one Node process with the local SQLite database.
Multi-process deployment requires a shared challenge store and suitable database.

Only the Todo CRUD and priority features are in this milestone. Authentication
is their prerequisite; recurrence scheduling, notification delivery, and related
feature UIs are not implemented by this backend milestone.

Verify with `npm run typecheck`, `npm run lint`, and `npm test`.
Once the UI is present, also run `npm run build` and `npm run test:e2e`.
