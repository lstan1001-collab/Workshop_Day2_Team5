# Backend contract

The app runs on the Next.js Node.js runtime, with SQLite in `todos.db` by default.
Set `DATABASE_PATH` to a file in a persistent directory for deployment.
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
Challenges are stored in SQLite so workers sharing the same database can complete
the same ceremony. SQLite must reside on persistent storage; separate database
files or hosts do not share challenges or account data.

Signed-in users can add another passkey with `POST /api/auth/add-passkey-options`
and `POST /api/auth/add-passkey-verify`. Both determine the account from the
session; verification accepts `{ response }` and returns `{ success: true }`.
There is no account recovery if all passkeys are lost.

The backend supports Todo CRUD and priority plus recurring completion,
reminder polling, subtasks, templates, export/import, and calendar holidays
(PRPs 03-05, 07, 09-10). Authentication is their prerequisite.

Verify with `npm run typecheck`, `npm run lint`, and `npm test`.
Once the UI is present, also run `npm run build` and `npm run test:e2e`.
For real-server virtual-passkey coverage, set `AUTH_E2E_DATABASE_PATH` to an
absolute path for a disposable database, then run
`npx playwright test --config playwright.auth.config.ts`. Remove that database
afterward; the test creates an account in it.

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
- `PUT /api/todos/[id]`: `UpdateTodoInput`; returns the updated Todo, or
  `{ todo, nextInstance }` when completing a recurring todo spawns its successor. Omitted
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

## Feature persistence (PRPs 03-05)

`todoDB.completeAndCreateNext(id, userId, input, calculateNextDueDate)` performs
the completion, next-instance insertion, and tag copying in one transaction.
Failure rolls back all writes. An already-completed row does not spawn another
instance. The successor inherits the updated title, priority, recurrence,
reminder offset and tags, but starts incomplete with no notification timestamp
or subtasks.

`findDueReminders(userId, now)` and `markReminderSent(id, userId, now)` compare
offset-aware timestamps at millisecond precision. Eligibility runs from the
reminder trigger through the due instant, inclusive; overdue reminders are
excluded. Changed due dates or reminder offsets clear the notification stamp;
unrelated edits and unchanged settings preserve it. Browser delivery remains
best-effort across tabs, not an exactly-once guarantee.

All `subtaskDB` methods require the owning user ID. Child completion is
independent of parent completion; additions use the current maximum position
plus one, starting at zero. Deletion does not compact positions. Foreign keys
are enabled on every connection so parent deletion removes children and tag
associations. Schema initialization adds missing todo feature columns without
replacing existing rows and is safe to repeat.

## Templates, backups and calendar (PRPs 07, 09-10)

All endpoints authenticate first and follow the error contract above. Template
IDs are positive safe integers; missing and foreign-owned templates return 404.

- `GET /api/templates`: `Template[]` for the session user.
- `POST /api/templates`: `CreateTemplateInput`; returns a Template (201).
- `PUT /api/templates/[id]`: `UpdateTemplateInput`; returns a Template. Omitted
  fields are preserved and validation considers the combined state.
- `DELETE /api/templates/[id]`: `{ success: true }`; instantiated todos remain.
- `POST /api/templates/[id]/use`: no body; returns a fresh Todo (201) with
  `subtasks` and `tags` arrays. Creation is transactional.

Templates snapshot checklists (titles and array order); instances start with
incomplete subtasks and no tags. Names/titles cannot be whitespace. Relative
due-date offsets must be positive integer minutes when set. Recurring templates
require a pattern and offset; reminders require an offset. Use computes the due
instant from server time and returns Singapore ISO with `+08:00`. Unlike the
PRP's silent checklist fallback, corrupt stored templates return a logged 500
without creating an incomplete task.

- `GET /api/todos/export?format=json|csv`: downloads all of the current user's
  todos, ignoring UI filters. JSON is the default; unsupported formats are 400.
  Filenames use the current Singapore date and responses are private/no-store.
- JSON is a `TodoExport` envelope: `{ version: 1, exported_at, todos }`.
  Items contain todo properties, `subtasks: [{title, completed, position}]`,
  and `tags: [{name, color}]`, without IDs/ownership/notification stamps.
- CSV uses fixed columns `ID,Title,Completed,Due Date,Priority,Recurring,Pattern,Reminder`,
  CRLF row separators and RFC 4180 escaping. Formula-leading cells are prefixed
  with an apostrophe to prevent spreadsheet formula execution. JSON stays lossless.
- `POST /api/todos/import`: accepts the JSON envelope, validates the whole
  document, then imports atomically with new IDs. Returns
  `{ success: true, imported, tagsCreated, tagsReused }`. Tag names are reused
  case-insensitively within the importing user; existing tag colors are kept.
  Subtask order/completion and creation timestamps are preserved; positions are
  compacted from zero. Historical due dates are allowed; notification stamps
  reset. Import creates duplicates rather than updating existing todos.

Import rejects unknown fields, invalid dates/enums, blank names/titles, invalid
tag colors and inconsistent recurrence/reminder settings. Malformed JSON returns
`Invalid JSON format`; an invalid envelope returns
`Failed to import todos. Please check the file format.` (both 400).
Empty exports/imports are supported. SQLite UTC creation timestamps and ISO
timestamps are accepted; due dates are normalized to Singapore ISO.

`GET /api/holidays` returns `{ holidays: Holiday[] }`. Providing both
`?year=YYYY&month=M` scopes holidays to the visible Sunday-start 42-day grid,
including adjacent-month cells; malformed/incomplete ranges are 400. Public
holiday records are global, but this read endpoint still requires authentication.

Run `npx tsx scripts/seed-holidays.ts` from the project root to seed 2026-2027
Singapore holidays. The script transactionally upserts dates and is safe to
repeat without duplicating them. Dates come from the
[Ministry of Manpower](https://www.mom.gov.sg/employment-practices/public-holidays),
checked 17 November 2026; substitute holidays are labeled as conditional on a
Sunday rest day. Review the official source before extending the seeded years.
No live holiday service is called by the app; unseeded years return empty data.

Focused route integration checks: `npm test -- tests/productivityApi.test.ts`.
They exercise the actual routes and SQLite persistence with a mocked session
provider in a temporary directory, including ownership, backups, rollback,
validation, Singapore midnight and calendar-grid boundaries.
`npm run test:e2e -- --config=playwright.frontend.config.ts` also includes a
live browser round-trip through the real routes, JWT session verification and
SQLite, without network mocks. That test creates a uniquely named user in the
local database and deletes only that user's records afterward.
