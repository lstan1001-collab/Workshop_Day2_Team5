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

## Todo API

All todo routes require a valid session. Errors use `{ error: string }` with
400 for invalid input, 401 for missing authentication, and 404 for absent or
foreign-owned todo IDs. Malformed JSON is 400; non-JSON writes are 415.
Unexpected server failures are logged without request bodies and return 500.

- `POST /api/todos`: `CreateTodoInput`; returns a Todo and status 201.
- `GET /api/todos`: returns `Todo[]` with `subtasks` and `tags` arrays.
  Optional `?priority=high|medium|low` filters direct API consumers; invalid values
  return 400. The UI can still combine filters locally.
- `GET /api/todos/[id]`: returns one Todo.
- `PUT /api/todos/[id]`: `UpdateTodoInput`; returns the updated Todo. Omitted
  fields stay unchanged. `priority: null` is rejected; create omission/null
  defaults to medium. Only documented writable fields are accepted.
- `DELETE /api/todos/[id]`: returns `{ success: true }`; child subtasks and tag
  links cascade, but reusable tags remain.

Due dates accept ISO date/time strings, with `+08:00` assumed when no offset is
provided, and return canonical Singapore ISO strings with the offset. New or
changed dates must be at least server-now + 60 seconds. Unchanged overdue dates
do not block title/completion edits. `null` removes a due date, provided recurrence
and reminders do not still require it. DB timestamps use SQLite's UTC convention;
clients must interpret those timestamps as UTC when sorting/displaying them.
Completed ordering uses `updated_at` (or `created_at`), as specified in PRP 01;
editing a completed item can therefore move it in that section.
