# PennyNest

A student savings tracker (panda-themed, confetti included) rebuilt as a **Cloudflare Worker + D1** app.
The frontend is plain HTML/CSS/JS served as static assets; all data lives in D1 so the same account
shows the same transactions, budgets, goals, Cozy Nests and inbox on every device.

---

## 1. What's in this package

```
pennynest/
├── src/                        # Worker (backend) source — TypeScript
│   ├── index.ts                # Hono app entry: bootstrap + static-asset fallthrough
│   ├── api.ts                  # every /api route (auth, data, admin)
│   ├── auth.ts                 # PBKDF2-SHA256 PIN hashing, tokens, validators
│   ├── db.ts                   # idempotent schema + idempotent admin seed
│   ├── csv.ts                  # CSV export helpers
│   └── types.ts                # Bindings (DB, ASSETS) + shared types
├── public/                     # Frontend (served as static assets)
│   ├── index.html
│   ├── style.css
│   ├── script.js               # all client logic (API layer + views + actions)
│   └── favicon.svg
├── migrations/
│   ├── 0001_schema.sql         # D1 schema (idempotent, CREATE ... IF NOT EXISTS)
│   └── 0002_seed_admin.sql     # permanent admin seed (idempotent)
├── package.json
├── wrangler.toml
└── README.md
```

---

## 2. Deploy to your own Cloudflare account — exact order

You need a free Cloudflare account (D1 is included in the free plan) and Node.js installed.
Run every command **inside the extracted `pennynest/` folder**.

### Step 1 — Install Node.js

Install the current **Node.js LTS** (18 or newer) from <https://nodejs.org>.
Then confirm:

```bash
node -v
npm -v
```

### Step 2 — Install dependencies

```bash
npm install
```

This installs `hono` and `wrangler` (the Cloudflare CLI).

### Step 3 — Log in to Cloudflare

```bash
npx wrangler login
```

A browser window opens; approve access for your Cloudflare account.
Check it worked with:

```bash
npx wrangler whoami
```

### Step 4 — Create the D1 database

```bash
npx wrangler d1 create pennynest-production
```

The command prints something like:

```
[[d1_databases]]
binding = "DB"
database_name = "pennynest-production"
database_id = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
```

**Copy that `database_id` value.**

### Step 5 — Put the `database_id` into `wrangler.toml`

Open `wrangler.toml` and replace the placeholder:

```toml
[[d1_databases]]
binding = "DB"
database_name = "pennynest-production"
database_id = "REPLACE_WITH_YOUR_DATABASE_ID"   # <-- paste your id here
```

Save the file. The Worker will not work until this is a real id.

### Step 6 — Apply the schema, then the admin seed (both `--remote`)

```bash
npm run db:schema:remote
npm run db:seed:remote
```

Those two scripts run:

```bash
npx wrangler d1 execute pennynest-production --remote --file=./migrations/0001_schema.sql
npx wrangler d1 execute pennynest-production --remote --file=./migrations/0002_seed_admin.sql
```

Both files are **idempotent** — you can run them again at any time. The seed never
overwrites an existing admin PIN, so a PIN you change later survives a re-run.

Verify the admin row exists:

```bash
npm run db:verify
```

Expected output contains `hakhnish99@gmail.com | admin`.

### Step 7 — Deploy the Worker

```bash
npx wrangler deploy
```

Wrangler prints your live URL, e.g.:

```
https://pennynest.<your-subdomain>.workers.dev
```

Open that URL — PennyNest is live.

> Note: this is `wrangler deploy` (a **Worker** with static assets), not
> `wrangler pages deploy`. The app does not use Pages.

---

## 3. Admin account

| Field | Value |
|---|---|
| Email | `hakhnish99@gmail.com` |
| PIN | `1234` |
| Role | `admin` |

The account is seeded by `migrations/0002_seed_admin.sql` **and** self-healed by the Worker on
the first API request (`seedAdmin()` in `src/db.ts`), so it exists no matter which order you
deployed things. It works from any device — just log in with the email and PIN.

The admin account cannot be deleted through the API, and public registration can only create
`role = 'user'` accounts.

**Change the admin PIN:** log in as admin → profile menu → *Change PIN* → enter the new 4-digit
PIN. It is stored only as a salted PBKDF2-SHA256 hash (`pin_hash` + `pin_salt`); the plaintext PIN
is never stored, returned by the API, or included in any export. Re-running the seed will not
reset it.

---

## 4. Local development (optional)

```bash
npm run db:schema:local
npm run db:seed:local
npm run dev
```

`npm run dev` starts a local `wrangler dev` on <http://localhost:8787> using a local SQLite copy
of the database (under `.wrangler/`). Nothing local touches your remote D1.

---

## 5. API surface (for reference)

Public: `GET /api/health`, `POST /api/auth/register`, `POST /api/auth/login`.

Everything else requires `Authorization: Bearer <token>` and is scoped to the caller's own data:
`GET /api/bootstrap`, `GET /api/auth/me`, `POST /api/auth/logout`,
`POST /api/me/avatar`, `POST /api/me/theme`, `POST /api/me/pin`, `GET /api/users/search`,
`/api/transactions` (GET / POST / POST bulk / DELETE `:id` / DELETE all),
`/api/budgets` (GET / PUT / DELETE `:category`),
`/api/goals` (GET / POST / POST `:id/deposit` / DELETE `:id`),
`/api/nests` (GET / POST / POST `:id/contribute` / POST `:id/members` /
GET+POST `:id/messages` / DELETE `:id`),
`/api/inbox` (GET / POST `:id/read` / POST `read-all`),
`DELETE /api/me`, `POST /api/me/reset`.

Admin only (`role = 'admin'`): `GET /api/admin/users`, `/api/admin/goals`, `/api/admin/stats`,
`/api/admin/nests`, `GET /api/admin/export/all.json`, `GET /api/admin/export/csv/:kind`,
`GET /api/admin/users/:id/download.csv`, `POST /api/admin/messages`,
`DELETE /api/admin/users/:id` (cascade).

Ownership is enforced server-side on every read and write; requests for someone else's rows
return 403/404 rather than data. Exports never contain `pin_hash` or `pin_salt`.

---

## 6. Known broken / untested

Read this before you rely on anything below.

1. **The 6 mandated end-to-end Playwright scenarios were never executed.** Chromium launched
   successfully after installing system libraries, but the browser tests were stopped before
   they ran. The API was verified with `curl` instead (login, wrong PIN, token enforcement,
   ownership, admin gating, nests, chat, inbox, exports, delete-cascade) — but the UI flows
   (clicking through pages, the admin tables, inbox badge, confetti) have **not** been
   browser-tested.
2. **Nothing has ever been deployed from this project.** No live URL exists yet. The first real
   deployment will be the one you run with the steps above, so any `wrangler.toml` /
   `compatibility_date` issue will surface there rather than having been caught earlier.
3. **`pin` length is fixed at exactly 4 digits** — that is intentional, not a bug, but it means
   no long passphrases.
4. **Sessions never expire.** A token stays valid until the user logs out (which deletes the
   row). There is no TTL sweep.
5. **Auto-refresh is 10-second polling**, not push. Two devices converge within ~10 s, not
   instantly, and each open tab costs one request per 10 s.
6. **`compatibility_date = "2026-10-23"`** in `wrangler.toml` is recent by design. If your
   installed Wrangler rejects it, lower it to a date your Wrangler knows (e.g. `2025-01-01`) —
   nothing in the code depends on a newer runtime.
7. **No rate limiting / brute-force lockout on login.** A 4-digit PIN is a 10,000-guess space.
   Fine for a class project, not for anything real.
8. **`migrations/` are applied by hand** with the two `npm run db:*:remote` commands. There is no
   migration-tracking table, so re-running is safe only because every statement is idempotent.
