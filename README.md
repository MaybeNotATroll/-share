# Numa

Numa is a number-based file-sharing app built with Next.js, Supabase Postgres, and private Supabase Storage. “Numa” is a provisional product name.

## What it does

- Enter a numeric string to open its space. Leading zeroes are preserved.
- Codes up to 20 digits are public spaces and are created on first open or upload.
- Longer codes identify unlisted private spaces. A generated private code has exactly 100 decimal digits and is reserved before it is returned.
- Anyone with a space code can list, upload, preview supported files, and download files. The code is a bearer credential, not encryption.
- Private-space creation returns a separate, one-time management key. Only that key authorizes deleting files or a space. Public-space moderation requires the server-side moderation token.
- Upload objects are private, use random object keys, and are served through short-lived signed URLs after server-side space/file authorization.

Public content can be viewed and downloaded by anyone who knows the public code. Anyone who obtains a private code can access that private space. Do not share either kind of code where it should remain confidential.

## Local setup

Requirements: Node.js 24 or newer and a Supabase project.

1. Install packages: `npm ci`.
2. Copy `.env.example` to `.env.local`.
3. Configure the Supabase variables below.
4. Apply `supabase/migrations/20261026000000_initial.sql` to the project. Use the Supabase SQL Editor or the Supabase CLI against the intended project.
5. Run `npm run dev`, then open `http://localhost:3000`.

The migration creates the schema, constraints, indexes, quota/rate-limit functions, and a **private** `share-files` Storage bucket. It revokes direct anonymous/authenticated table and object access. The application uses the service-role key only in server route handlers; never add it to a `NEXT_PUBLIC_*` variable or browser code.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only database and Storage access |
| `RATE_LIMIT_SECRET` | Recommended | HMAC key for pseudonymous, per-IP rate-limit identifiers. If unset, the server-only service-role key is used. |
| `MODERATION_TOKEN` | For moderation | A bearer token authorizing restricted moderation actions |
| `CRON_SECRET` | For scheduled cleanup | Secret used by the cleanup route; set this in Vercel for the configured cron |
| `MAX_FILE_BYTES` | No | Per-file limit, from 1 byte to 50 MiB; default `52428800` |
| `MAX_FILES_PER_REQUEST` | No | Files reserved in one request, from 1 to 5; default `5` |
| `MAX_SPACE_BYTES` | No | Reserved plus uploaded bytes per space; default `1073741824` (1 GiB) |
| `MAX_FILES_PER_SPACE` | No | Reserved plus uploaded files per space; default `1000` |

Use long, unique random values for rate-limit, moderation, and cron secrets. Do not commit `.env.local` or real credentials.

## Upload limits and cleanup

The initial version caps each file at 50 MiB (or a lower `MAX_FILE_BYTES` value), each request at five files, and each space at 1 GiB/1,000 files by default. Storage enforces the 50 MiB hard limit independently of the app. A file is reserved against its space quota before upload; uncompleted reservations are removed after 24 hours. Objects deleted while their signed upload token might still be valid are queued for a final cleanup after three hours. Uploads go from the browser directly to the private Storage bucket using a one-use signed upload URL, avoiding buffering large file bodies in a serverless function. The server verifies the resulting object size and file signature before publishing it in the listing.

Default per-IP limits include 20 new public spaces/hour, five private-number requests/minute, 12 upload reservations/minute, five reports/minute, and six management operations/minute. Opening/listing/downloading are limited to 120 requests/minute. These limits are basic abuse controls, not a substitute for provider-level DDoS controls or moderation.

Images (JPEG, PNG, GIF, WebP, AVIF), MP4, WebM, and PDF can be previewed. SVG and HTML are not allowed. Supported office formats, RTF, ZIP, text, CSV, Markdown, and JSON are downloadable. Unknown extensions are rejected. The browser-provided MIME type is only a consistency check; the server chooses stored MIME types from an allowlist and checks signatures for supported binary formats.

Vercel runs `/api/cleanup` daily at 03:00 UTC using `vercel.json`. Set `CRON_SECRET` in Vercel so only the scheduled request can invoke it. Cleanup deletes abandoned pending objects/rows older than 24 hours, old rate-limit windows, and generation idempotency records older than 30 days. It does not expire shared spaces or completed files. If using another host, schedule an authenticated GET to `/api/cleanup` daily with the cron secret in the Authorization bearer header.

## Database and Storage access

- The exact code is stored in a unique `text` column with a numeric-string constraint. Public codes are 1–20 digits; private codes are 21–100 digits.
- Private codes are generated server-side with `crypto.randomInt`; each candidate is inserted under a database unique constraint, with bounded collision retries. Generation requests also have a database idempotency key.
- Anonymous browser sessions have no direct Postgres or Storage permissions. API routes use the server-only service-role key, validate the code, and scope file queries to the matched space.
- Every object is in a private bucket. Signed upload/download URLs grant time-limited access only to the specific random object key; file metadata is not returned until upload verification is complete.
- Rate-limit identifiers are HMACs of the request IP and action, not raw IPs or space codes. The app does not send space codes or file metadata to analytics or third-party fonts.
- Space pages are marked `noindex`; private API responses are `no-store`; the app sets `Referrer-Policy: no-referrer` and security headers.
- Behind a proxy other than Vercel, configure it to overwrite `x-real-ip` with a trusted client address; do not pass through a client-supplied value.

## Reporting and moderation

Visitors can report a listed file for illegal content, abuse, copyright concern, or another concern. Reports are recorded in the `reports` table. An operator should review pending reports in the Supabase dashboard, investigate the associated file/space, and take action under the service's legal and moderation policy.

The restricted `POST /api/moderation` endpoint requires the moderation token in the Authorization bearer header and accepts either:

- `{ "code": "<space-code>", "action": "block-space" }` to stop future access and uploads; or
- `{ "code": "<space-code>", "action": "delete-file", "fileId": "<file-uuid>" }` to remove one file and its metadata.

Do not expose the moderation token to visitors or automate removals without review. The anonymous controls and quotas reduce abuse but cannot prevent determined abuse, illegal uploads, or all denial-of-service attempts. Configure a staffed review workflow and any provider/legal processes required for your deployment.

## Deployment to Vercel

1. Create a Supabase project and apply the migration before deploying.
2. Import this repository into Vercel as a Next.js project.
3. Set the required variables above in the Vercel project settings for the appropriate environments. Keep service-role, moderation, and cron secrets server-side.
4. Deploy. Confirm the Vercel Cron is enabled and `CRON_SECRET` is configured.
5. Test a public space, generate a private space, and upload/download a small file in each. Redeploy, then reopen the same spaces and verify the files remain available. This confirms files are in persistent object storage, not the application filesystem.

If using a nonstandard Supabase hostname, update the CSP host allowlist in `next.config.ts` to the exact trusted Supabase host before deployment.

## Checks

- `npm test` — unit tests for number/string handling, filename validation, allowed file types, and file signatures.
- `npm run typecheck` — TypeScript checks.
- `npm run build` — production Next.js build.

An opt-in integration test exercises concurrent public opens, generation idempotency, private creation, signed uploads/downloads, and management authorization against a configured staging deployment:

```sh
RUN_SUPABASE_INTEGRATION=1 BASE_URL=https://your-staging-app.example npm test
```

It creates a temporary public space and a private space, uploads a small file, and deletes the private test space. Use only a disposable staging project. The repository does not include Supabase credentials, so these integration tests were not run here. Database concurrency/RLS behavior, Storage policy behavior, scheduled cleanup, and end-to-end flows must be verified against staging before production use.

## Operational notes

- Keep request-path logging disabled or redact numeric path segments at the hosting/observability layer. A private code appears in `/space/<code>` and API request paths because direct numeric URL navigation is supported.
- The private management credential is displayed only in the generator response. Save it separately; it cannot be recovered from the database, and a space code alone cannot perform destructive management actions.
- Signed URLs are bearer links for their short validity window. Do not paste them into third-party services or log them.
- Public spaces are intentionally open to contributors and readers. There is no user account, file ownership, end-to-end encryption, or automated content scanning in this initial version.
