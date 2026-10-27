# Numa

Numa is a number-based file-sharing app built with Next.js App Router, Supabase Postgres, and private Cloudflare R2 object storage using the official AWS S3 SDK. Existing Supabase Storage objects remain supported during migration. “Numa” is a provisional product name.

## What it does

- Enter any numeric string of 1–100 digits to open the private space for that exact number. Leading zeroes are preserved. A space is stored the first time a file is posted to it.
- Every space is private: its files can only be listed, previewed, downloaded, or added by someone who supplies the exact number. No listing of spaces exists.
- Visitors can view and post images, videos, and files. New uploads can be deleted through **My Posts** in the original browser; other visitors cannot delete them. The operator can still moderate content and block spaces.
- Images appear automatically and videos preload with playback controls as files are listed, including after uploads and “Load more”. Videos do not autoplay; browsers may limit preloading. Failed previews offer a retry button, which requests a fresh authorized URL. PDF previews remain opt-in.
- “Generate a private number” draws a fully random 100-digit code with `crypto.randomInt`, checks whether anything has been posted under it, and draws again if so. The unused code is displayed with a copy button.
- Upload objects are private and use random object keys. New owner-managed downloads are streamed through an application authorization check; legacy files retain their short-lived signed download links.

The number is a read/post credential (a bearer secret, not encryption), **not proof of ownership**. Short numbers are easy to guess, so use a generated 100-digit number for anything that should stay private, and never share it where it should remain confidential.

If the app responds “The service is not set up yet”, check the server-only Supabase/R2 variables, trusted proxy configuration, the rate-limit secret, and that **all** database migrations below have been applied. R2 does not replace Supabase Postgres.

## Local setup

Requirements: Node.js 24 or newer, a Supabase project, and the private R2 bucket `number-share-files`.

1. Install packages: `npm ci`.
2. Copy `.env.example` to `.env.local`.
3. Configure the server-only variables below and the R2 bucket settings.
4. Apply `supabase/migrations/20261026000000_initial.sql`, `supabase/migrations/20261027000000_r2_storage.sql`, `supabase/migrations/20261027010000_daily_upload_quota.sql`, then `supabase/migrations/20261027020000_owner_expiration.sql`. For an existing installation, apply only unapplied migrations; do not rerun old migrations. The owner/expiration migration is safe to rerun. Use the Supabase SQL Editor or CLI against the intended project.
5. Run `npm run dev`, then open `http://localhost:3000`.

The initial migration creates the schema, constraints, indexes, quota/rate-limit functions, and legacy **private** `share-files` Supabase Storage bucket. It revokes direct anonymous/authenticated table and object access. The R2 migration marks existing file/cleanup rows as `supabase`, adds the service-role-only `reserve_r2_upload` wrapper that atomically records new uploads as `r2`, and adds an expiration index and transactional deletion queue trigger. Legacy writers still default to Supabase during rollout; missing the new RPC fails uploads before any R2 URL is issued. It does not copy or discard old objects. Existing files also expire 24 hours after their original reservation timestamp; applying this change makes older files inaccessible and eligible for cleanup. Never add the service-role key to a `NEXT_PUBLIC_*` variable or browser code.

The daily-quota migration adds a private usage ledger, expiring reservations, and transactional completion accounting. **Pause uploads during rollout**, finish or cancel pending uploads first, apply the migration, and deploy this application version together. The old R2 RPC signature is removed so old application instances fail closed; drain or disable old instances rather than rolling back to unmetered uploads. Existing ready files remain untouched. Unfinished pre-migration uploads have no attributable IP and must be cancelled/retried; they cannot be completed by this version. Historical successful uploads cannot be backfilled by IP because their IPs were not stored; accounting starts at rollout.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only database and legacy Supabase Storage access |
| `R2_ACCOUNT_ID` | Yes for new uploads | Cloudflare 32-character account ID; code constructs `https://<account-id>.r2.cloudflarestorage.com` with S3 region `auto` |
| `R2_ACCESS_KEY_ID` | Yes for new uploads | R2 S3 API access key ID, scoped to `number-share-files` |
| `R2_SECRET_ACCESS_KEY` | Yes for new uploads | R2 S3 API secret access key; server-only |
| `RATE_LIMIT_SECRET` | Recommended | HMAC key for pseudonymous, per-IP rate-limit identifiers. If unset, the server-only service-role key is used. |
| `TRUSTED_PROXY_IP_HEADER` | Other production hosts | Header overwritten with a single validated client IP by your trusted reverse proxy; ignored on Vercel. No automatic forwarded-header fallback. |
| `MODERATION_TOKEN` | For moderation | A bearer token authorizing restricted moderation actions |
| `CRON_SECRET` | For scheduled cleanup | Secret used by the cleanup route; set this in Vercel for the configured cron |
| `DONATION_URL` | No | Operator-created HTTPS hosted payment link; blank/invalid means donations disabled. This URL is public, not a payment secret. |
| `MAX_FILES_PER_REQUEST` | No | Files reserved in one request, from 1 to 5; default `5` |
| `MAX_SPACE_BYTES` | No | Reserved plus uploaded bytes per space; default `1073741824` (1 GiB) |
| `MAX_FILES_PER_SPACE` | No | Reserved plus uploaded files per space; default `1000` |
| `UPLOAD_RATE_LIMIT` | No | Upload reservation requests per IP/window, from 1 to 10,000; default `12` |
| `UPLOAD_RATE_WINDOW_SECONDS` | No | Upload rate-limit window, from 1 to 86,400 seconds; default `60` |

Use long, unique random values for rate-limit, moderation, and cron secrets. Do not commit `.env.local` or real credentials.

Use the same stable `RATE_LIMIT_SECRET` on every application instance. Changing it (or the fallback service-role key when no dedicated secret is set) changes IP identities and resets their effective usage; coordinate rotation at midnight UTC with old instances drained.

The bucket name is fixed in code as `number-share-files`; there is no bucket-name or endpoint environment variable. None of these variables uses the `NEXT_PUBLIC_` prefix. Storage and Supabase modules have server-only import boundaries. Invalid optional numeric limits fall back to their documented defaults.

### Cloudflare R2 bucket setup

1. Create `number-share-files`. Keep both **Public Development URL (r2.dev)** and public custom domains disabled. Do not use a public bucket URL.
2. Create R2 S3 API credentials with **Object Read & Write** permissions restricted to this bucket. Enter them directly in your local environment or Vercel; do not paste them into GitHub, source files, screenshots, logs, or chat.
3. Add a bucket CORS policy allowing only your exact application origins. For example, replace this example origin with the intended production origin (and add localhost or specific preview origins only when needed):

   ```json
   [{
     "AllowedOrigins": ["https://your-app.example"],
     "AllowedMethods": ["PUT", "GET", "HEAD"],
     "AllowedHeaders": ["Content-Type", "Content-Length", "If-None-Match", "Range"],
     "ExposeHeaders": ["ETag", "Content-Range", "Content-Length"],
     "MaxAgeSeconds": 300
   }]
   ```

   CORS does not authorize requests or make the bucket public. Uploads require the signed `Content-Type`, exact `Content-Length`, and `If-None-Match: *`. The browser sets Content-Length from the raw File body; do not set that forbidden header manually or wrap the file in FormData. R2 rejects changes to signed headers and repeat writes to an existing key. This prevents publishing a validated object and later overwriting its content through the upload URL.
4. Add an R2 lifecycle rule for all objects to **delete objects after one day**, plus abort incomplete multipart uploads. This is a required safety net for orphaned/in-flight uploads and scheduler outages, not the authorization mechanism; lifecycle deletion is asynchronous and does not guarantee deletion at exactly 24 hours. Do not point other applications at this bucket.
5. Keep the legacy Supabase `share-files` bucket private until its old files and cleanup queue have drained. New uploads never use it. If using a nonstandard Supabase hostname, update the exact trusted CSP host in `next.config.ts`.

## Upload limits and cleanup

There is no smaller per-attachment size limit: one attachment can use the full **500 MB (500,000,000 bytes)** daily allowance if that IP has enough remaining capacity. The obsolete `MAX_FILE_BYTES` environment variable is ignored, including on existing deployments. No additional database migration is needed for this attachment-size change if all migrations listed above are already applied.

The server still caps each request at five files and each space at 1 GiB/1,000 files by default. Supabase's existing row-locked `reserve_upload` RPC reserves bytes and file count atomically before signing, including pending files, so concurrent requests cannot bypass space quotas. The five-minute R2 PUT signature binds the exact reserved size and MIME type, and conditional writes prohibit overwriting an existing object. Uploads go directly from the browser to R2 to avoid Vercel's request-body limit; the server verifies actual object length, MIME type, and file signature through a bounded S3 Range read before publishing.

Each IP may successfully upload **500 MB (500,000,000 bytes, decimal)** per UTC calendar day, across all spaces. `reserve_r2_upload` and the completion trigger share a per-IP transaction advisory lock. Reservations check today's successful bytes plus all still-active pending bytes before issuing a URL. They last ten minutes; failures/cancellation remove the pending row, while abandoned reservations stop holding daily capacity automatically even without cron. Expired reservations cannot complete. Pending metadata and any orphan object still follow the existing 24-hour expiration/cleanup and R2 lifecycle rules; expiring a daily reservation does not extend file lifetime.

Only the verified `pending → ready` transition adds bytes to the persistent daily ledger, in the same transaction that publishes the file. Completion retries do not double-count. A transfer crossing midnight counts on its UTC **completion** day; active reservations continue to protect capacity across midnight. A new UTC date automatically selects a fresh daily counter, independently of server timezone and cron. Deletion, moderation, and expiration of successful files never refund successful daily usage.

Quota rejection includes authoritative byte totals, attempted size, would-be total, exact overage, remaining allowance, and the next UTC reset timestamp; the browser displays reset in local time. Fractional units include exact bytes. If other pending uploads temporarily occupy the allowance, a separate retry message avoids misreporting those bytes as successful uploads. Batch quota rejections affect only the rejected files, not other accepted reservations or previously successful files. Existing rate limits and space limits still apply.

Default per-IP limits include 20 new spaces/hour (counted on a space's first upload), ten number-generation requests/minute, 12 upload reservation requests/minute (configurable above), and five reports/minute. Each upload request can reserve up to the configured file count. Opening/listing/downloading are limited to 120 requests/minute. Limits use the existing shared Postgres RPC, not per-instance memory. These are basic abuse controls, not a substitute for provider-level DDoS controls or moderation.

Images (JPEG, PNG, GIF, WebP, AVIF), MP4, WebM, and PDF can be previewed. SVG and HTML are not allowed. Supported office formats, RTF, ZIP, text, CSV, Markdown, and JSON are downloadable. Unknown extensions are rejected. The browser-provided MIME type is only a consistency check; the server chooses stored MIME types from an allowlist and checks signatures for supported binary formats.

**Files expire after reservation, not completion.** New uploads offer 1, 6, 12, or 24 hours (default); the server rejects other values and the database caps retention at 24 hours. Legacy files retain their original 24-hour deadline. Server checks exclude expired files even when cleanup is delayed. Managed content URLs reauthorize every request, including video ranges; they do not disclose R2 download signatures. Legacy download signatures remain limited to at most 60 seconds and the remaining lifetime. Spaces do not expire. Previously delivered bytes cannot be revoked, and a transfer accepted before deletion/expiry may finish afterwards.

Vercel runs `/api/cleanup` daily at 03:00 UTC using `vercel.json`. Set a 32+ byte `CRON_SECRET` so only authenticated scheduled requests can invoke it. It drains expired pending **and ready** metadata in batches, then deletes due objects from their recorded storage provider. A database trigger atomically preserves each object key in a durable cleanup queue and releases quota when metadata is deleted. Moderation/cancellation revoke metadata before immediate object removal. Fresh deletions are queued again after ten minutes (three hours for legacy Supabase upload tokens), covering still-valid upload links; expired files are queued immediately. Failed object removals retain their keys for retry, including S3 per-object errors returned inside a successful HTTP response. Cleanup only acknowledges a queue entry if its scheduled time has not changed.

The route also removes old rate-limit windows, generation idempotency records, and quota ledger days older than two UTC days; today's successful quota is never pruned or refunded. It works within a 45-second processing budget / 60-second route duration, returns **503** on failure or remaining backlog, and retries retained work on subsequent invocations. Failed provider batches are rescheduled with a 15-minute backoff so a failing object cannot starve later batches or the other provider. Monitor cron responses and queue age; Vercel does not automatically retry failed cron jobs. Configure an external authenticated scheduler with retries, or a more frequent Vercel schedule if your plan supports it, for higher traffic. Never put the secret in a query string. The checked-in daily schedule remains compatible with once-daily hosting plans. Physical deletion can lag expiry until the next successful run; the R2 lifecycle rule is an independent backstop. This code does not configure Cloudflare lifecycle rules, Vercel secrets, or monitoring for you.

## Database and Storage access

- The exact code is stored in a unique `text` column with a numeric-string constraint. All spaces are private regardless of length; the legacy `visibility` column is kept only to satisfy the existing schema constraint.
- Generated codes are produced server-side with `crypto.randomInt`. A candidate is rejected and redrawn (bounded retries) if its space has any file, pending or ready, or is blocked. Generation does not reserve the code; it is stored when the first file is posted.
- Anonymous browser sessions have no direct Postgres or Storage permissions. API routes use the server-only service-role key, validate the code, and scope file queries to the matched space.
- Every object is in a private bucket. Signed upload/download URLs grant time-limited access only to the specific random object key; file metadata is not returned until upload verification is complete.
- Rate-limit identifiers are HMACs of the request IP and action, not raw IPs or space codes. The app does not send space codes or file metadata to analytics or third-party fonts.
- Space pages are marked `noindex`; private API responses are `no-store`; the app sets `Referrer-Policy: no-referrer` and security headers.
- On Vercel (`VERCEL=1`), IP identity uses only the platform-overwritten `x-vercel-forwarded-for`, never browser JSON, `x-real-ip`, or arbitrary `x-forwarded-for`. Equivalent IPv6 spellings and IPv4-mapped addresses are canonicalized before HMAC hashing. Only hashes are persisted.
- On other production hosts, set `TRUSTED_PROXY_IP_HEADER` (for example `x-real-ip`), configure that proxy to **overwrite** the header with a single authoritative client IP, and firewall the origin so clients cannot bypass the proxy. Do not enable this for an untrusted passthrough header. Missing/invalid/multi-IP values fail closed with 503. Local `next dev` without a configured proxy shares loopback identity; production never silently falls back.

## Reporting and moderation

Visitors can report a listed file for illegal content, abuse, copyright concern, or another concern. Reports are recorded in the `reports` table. An operator should review pending reports in the Supabase dashboard, investigate the associated file/space, and take action under the service's legal and moderation policy.

The restricted `POST /api/moderation` endpoint requires the moderation token in the Authorization bearer header and accepts either:

- `{ "code": "<space-code>", "action": "block-space" }` to stop future access and uploads; or
- `{ "code": "<space-code>", "action": "delete-file", "fileId": "<file-uuid>" }` to remove one file and its metadata.

Do not expose the moderation token to visitors or automate removals without review. The anonymous controls and quotas reduce abuse but cannot prevent determined abuse, illegal uploads, or all denial-of-service attempts. Configure a staffed review workflow and any provider/legal processes required for your deployment.

## Deployment to Vercel

1. Create a Supabase project and apply all four migrations in order (only unapplied migrations on an existing installation). Follow the paused-upload rollout instructions above. Configure the private R2 bucket, CORS, lifecycle rule, and scoped credentials above.
2. Import this repository into Vercel. In **Settings → Build and Deployment**, select **Next.js** as the Framework Preset and set **Root Directory** to the repository root (leave it empty, not `app` or `src`). This is where `package.json`, `next.config.ts`, and `vercel.json` live. Use Node.js **24.x**.
3. Disable dashboard overrides for Build Command, Output Directory, and Install Command. The checked-in `vercel.json` pins the Next.js framework, `npm run build`, and `.next` output. Keep `package-lock.json` committed for reproducible dependency installation (`npm ci` locally). Remove any old `public`, `dist`, or `out` output setting and any `next export` build command.
4. In **Project → Settings → Environment Variables**, add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `RATE_LIMIT_SECRET`, `CRON_SECRET`, and `MODERATION_TOKEN` using the descriptions above. Mark sensitive values as sensitive where available. Select **Production** and only the **Preview/Development** environments that should have access; use separate disposable Supabase projects/R2 accounts with the same bucket name for staging. Add any optional limit variables there as needed. Do not create any `NEXT_PUBLIC_*` versions. Redeploy after variable changes: the account-specific CSP origin is read at build time as well as storage configuration at runtime.
5. Deploy the commit containing this configuration (or redeploy that commit with the build cache disabled). Confirm the build runs `next build`, uses the Next.js framework, and includes dynamic `/api/*` and `/space/[code]` routes. Confirm the Vercel Cron is enabled and `CRON_SECRET` is configured.
6. On staging, open/generate a number and upload/download a small file; test preview, replay rejection, wrong-space denial, size/quota/rate rejection, and moderation deletion. Verify expiration with aged test metadata and invoke authenticated cleanup twice, including a simulated storage failure and retry. Confirm expired files never receive download URLs and queued keys eventually disappear. Redeploy and verify unexpired files remain available. Do not use real user files for these checks.

These settings and migrations must be applied by the operator. No bucket, database migration, Vercel configuration, or deployment is created automatically by this repository change.

### Why “Missing public directory” occurs

This is a Next.js App Router application, not a static site. `next build` writes `.next` and Vercel's Next.js adapter deploys its server handlers and dynamic routes. A `public` folder is optional source content for static assets, **not** the build output. Expecting `public` indicates an incorrect effective framework/output configuration (for example, the **Other** preset or a stale Output Directory override); selecting a subdirectory as Root Directory can also prevent Vercel from discovering this project's configuration.

The repository previously specified only the cron in `vercel.json`, leaving framework/output selection to Vercel's project settings and auto-detection. The explicit settings now keep this deployment on the Next.js pipeline. Dashboard settings and private Vercel build logs are not tracked here, so the exact previous dashboard value must be confirmed in the failed deployment's settings/logs. Do not add an empty `public` folder, use `output: "export"`, or deploy `.next` as a generic static directory: API routes, private-space generation, and signed Storage operations require the Next.js server runtime.

The CSP allows the exact account-specific R2 S3 endpoint derived from `R2_ACCOUNT_ID`, not arbitrary R2 accounts.

## Checks

- `npm test` — unit tests for domain rules, expiration boundaries, configured limits, S3 signing/header checks, object verification, and cleanup retry behavior. Uses Node's built-in runner and server-only import condition.
- `npm run typecheck` — TypeScript checks.
- `npm run build` — production Next.js build.
- No lint script or lint configuration exists; no new lint tool is introduced.

Real PostgreSQL quota tests use the existing Node test runner and `psql` against a **disposable, fully migrated** database (not production):

```sh
QUOTA_TEST_DATABASE_URL=postgresql://localhost/numa_quota_test npm test
```

The additional owner/expiration database suite uses `OWNER_TEST_DATABASE_URL` pointed at a disposable database with the first three migrations already applied. It applies/reruns the fourth migration and tests managed reservation validation, immutable ownership/deadlines, per-IP usage, no deletion refunds, expired publication, and durable cleanup grace. Never point either test variable at production. Without these variables the database suites explicitly skip; passing mock-based tests does not establish real database behavior.

They create isolated test spaces/IP hashes and remove their metadata afterward. Tests cover below/exact/over limits, cross-space accounting, exact overage/remaining amounts, pending/cancelled/expired uploads, concurrent reservations/completions, idempotency, UTC reset and timezone independence, preservation of earlier files, deletion without refund, and database role restrictions. They leave storage-cleanup tombstones for their synthetic keys. Without this variable, database tests are explicitly skipped. Unit tests cover trusted IP handling and exact error formatting.

An opt-in integration test exercises opening an arbitrary number, generation, uploads/downloads, cross-space isolation, and rejection of the obsolete space-code-only management endpoint against a configured staging deployment:

```sh
RUN_SUPABASE_INTEGRATION=1 BASE_URL=https://your-staging-app.example npm test
```

It uploads a small file to R2 through the app and checks overwrite rejection and cross-space isolation. Other visitors cannot delete files; the original upload browser can use My Posts, or use moderation for early removal. Deleting database metadata queues storage cleanup, but do not delete the whole Supabase project before its storage queue is drained. Use only a disposable staging project/bucket. The repository does not include credentials. Although the quota database tests exercise real PostgreSQL transactions, actual R2 signed-header enforcement, browser CORS/local-time display, platform header overwriting, lifecycle rules, scheduled cleanup, and end-to-end flows must still be verified against staging before production use; passing local tests does not prove provider configuration.

## Operational notes

### Owner controls and storage meter rollout

Apply **only** `supabase/migrations/20261027020000_owner_expiration.sql` manually if the first three migrations are already installed. It adds ownership hashes and expiration metadata, preserves existing objects/deadlines, and retains existing daily accounting and deletion tombstones. Do not assign ownership to historical files based on an IP or space number. Apply the migration before deploying this application version.

On successful upload reservation the server creates/reuses an unguessable owner-session credential in an HttpOnly, SameSite cookie (Secure in production). Only its hash is stored with uploads. JavaScript cannot read it, and it is not returned in post listings or URLs. Bookmark `/my-posts` and reopen it in the same browser/profile. Clearing cookies, losing the device, or ending a private browsing session loses the only credential; there is no recovery, export, or cross-device ownership transfer. Cookies must be enabled. Current browsers coordinate upload reservation across tabs using Web Locks so first uploads share the issued cookie. On older browsers without Web Locks, finish the first reservation before uploading in another tab to avoid overwriting the initial owner session. Existing files cannot be claimed retroactively.

Owner deletion revokes metadata transactionally before attempting physical deletion. Failed storage removal leaves a durable queue entry for retry, not an accessible managed download. Pending upload signatures may remain valid briefly, so cleanup tombstones retain a grace period to catch late writes. No deletion refunds successfully consumed daily upload allowance.

The fixed ring deliberately displays **this IP's daily upload allowance**, not personal storage capacity or global R2 usage. It includes successful bytes plus still-live pending reservations, with a 500 MB decimal maximum and midnight UTC reset. People sharing an IP share this allowance. The app has no configured R2 account-wide capacity and cannot infer one; no bucket capacity is invented. The meter refreshes on focus, upload completion/failure, and every minute. Unavailable data displays “Usage unavailable”, not a false zero. My Posts separately lists only the original browser's active files.

**Shorter physical retention requires scheduling:** the checked-in once-daily Vercel cron is unchanged for hosting-plan compatibility. For shorter deadlines, configure an external scheduler to request `GET /api/cleanup` every minute, authenticating with the configured cron secret as an Authorization bearer header, retries on 503, and alerting on failures/backlog; alternatively use a supported frequent Vercel cron schedule. Never put the secret in a URL. Database/API expiry blocks new access on time even without that scheduler, but physical object removal is eventual and can lag until a successful run. R2's asynchronous one-day lifecycle is only a safety net, not a shorter timer. Monitor cleanup queue age in Supabase; do not claim exact-time physical deletion.

Managed downloads now stream through the Next.js server to allow revocation even when R2 deletion fails. Uploads remain direct-to-R2. This adds server bandwidth and function-duration costs; verify the target hosting plan's streaming limits, video ranges, and near-500 MB transfers on staging before rollout. Do not substitute direct signed GETs for managed content to avoid those limits: that would weaken deletion guarantees. If the deployment cannot support these transfers, use an authorization-checking streaming worker/service before enabling managed uploads, rather than making the bucket public. Bytes already downloaded or a response authorized before revocation cannot be recalled.

### Optional hosted donations

The simplest option is an owner-created **Stripe Payment Link** for a donation product (configure customer-chosen amounts in Stripe if desired). Numa does not create an account, select a merchant, or supply a real payment link. Supply `DONATION_URL=https://buy.stripe.com/<your-real-link>` in the hosting dashboard and redeploy. Verify the merchant and live/test mode yourself. The allowlist also accepts HTTPS hosted links on `donate.stripe.com`, `paypal.com`, `www.paypal.com`, `paypal.me`, `www.paypal.me`, `ko-fi.com`, and `www.buymeacoffee.com`. Unconfigured, invalid, credential-containing, or unsupported links leave Donate disabled. No payment SDK, secret, card form, webhook, or payment database is needed; checkout is entirely provider-hosted. Donations never gate uploads.

### Android-only production verification

Use a disposable staging project/bucket first; these checks do not authorize altering real users' files.

1. In Supabase's mobile SQL Editor, check applied migrations and run only the new owner/expiration migration if its prerequisites exist. Confirm no existing spaces/files disappear.
2. In Vercel's mobile dashboard, verify existing secrets remain server-only, optionally add your real `DONATION_URL`, then deploy. Configure the frequent authenticated scheduler and retain private buckets plus R2's one-day lifecycle. Never share secret screenshots.
3. In Chrome, upload a small file with a 1-hour expiration. Open My Posts in the same browser; check filename, bytes, timestamps, and space navigation. Reload and verify management persists. Bookmark My Posts.
4. Open the space in Incognito. Check download/preview still work but the file is absent from Incognito's My Posts. In the original browser delete it; retry its previously obtained managed content link in Incognito and confirm access is denied. Other files must remain usable; daily allowance must not drop.
5. Upload another 1-hour test file; check it disappears and its saved content link fails after expiry, even before cleanup. In the dashboards, confirm the scheduler succeeds and its object/metadata are eventually removed; on cleanup failure verify retained queue work is retried.
6. Check zero/used/reserved allowance labeling, mobile scrolling/landscape, image/video/PDF previews, a larger download within hosting limits, and unchanged legacy links. Verify a new UTC day resets allowance, not deletion. Other people on the same network may share the meter.
7. Leave donation configuration blank and confirm a disabled button; then configure your real hosted link and verify the provider/merchant on its checkout page without sharing card information with Numa. Run the existing automated staging checks from a CI runner before approving production.

- Keep request-path logging disabled or redact numeric path segments at the hosting/observability layer. A private code appears in `/space/<code>` and API request paths because direct numeric URL navigation is supported.
- Disable/redact Cookie, Set-Cookie, Authorization, request/response-body, and signed-upload-URL capture in hosting, proxy, and error-reporting tools. Owner credentials must never be logged.
- Signed URLs are bearer links for their short validity window. Do not paste them into third-party services or log them.
- Anyone holding a number can read and contribute to its space. Browser-cookie ownership only applies to new managed uploads; there is no permanent account, end-to-end encryption, or automated content scanning.
