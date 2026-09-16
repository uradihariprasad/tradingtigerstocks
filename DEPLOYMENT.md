# Deploying to Render

PULSE is a long-running Next.js (Node runtime) app with a background scan engine and
PostgreSQL persistence. Render fits it well: one **Web Service** + one **Postgres**.

---

## Option A — Blueprint (recommended, ~3 minutes)

1. Push this repository to GitHub/GitLab.
2. Render Dashboard → **New → Blueprint** → select the repo.
3. Render detects `render.yaml` and provisions:
   - `pulse-fo-scanner` (Web Service, Node 22)
   - `pulse-fo-db` (PostgreSQL 16)
   - `DATABASE_URL` is wired automatically between them.
4. Click **Apply**. Build runs `npm ci && npm run build`; the service starts with
   `npm run start` and health-checks `/api/health`.
5. Open the service URL → paste your Upstox access token → the scanner arms itself.

The database schema is created automatically at server startup
(idempotent `CREATE TABLE IF NOT EXISTS`), so **no migration step is needed on Render**.

## Option B — Manual

1. **Postgres**: Dashboard → New → PostgreSQL → name it, pick a plan. Copy the
   *Internal Database URL*.
2. **Web Service**: Dashboard → New → Web Service → your repo, then:
   - Runtime: **Node**
   - Build Command: `npm ci && npm run build`
   - Start Command: `npm run start`
   - Health Check Path: `/api/health`
   - Environment Variables:
     | Key | Value |
     |---|---|
     | `DATABASE_URL` | internal URL from step 1 |
     | `NODE_VERSION` | `22` |
3. Deploy. Bind port is handled automatically (`next start` reads Render's `$PORT`).

---

## Operational notes

- **Region**: choose **Singapore** for the lowest latency to `api.upstox.com` (India).
  The DB and web service must be in the same region when using the internal
  `DATABASE_URL` (the Blueprint handles this).
- **Upstox token is per-user, entered in the UI** (connect panel / settings drawer).
  It is stored server-side in Postgres, never exposed to the browser. Upstox access
  tokens expire daily (early morning IST) — re-enter after expiry; the app shows the
  disconnected state cleanly.
- **F&O universe** is pulled from Upstox's public instrument master on boot and kept
  in the `instruments` table — no manual maintenance as contracts/expiries change.
- **Scan engine** runs inside the web process (instrumentation hook + scheduler) and
  snapshots to Postgres, so state survives restarts and redeploys.
- **Free plan caveat**: Render's free web service sleeps after inactivity; the engine
  pauses while asleep and resumes on the next request. For market-hours scanning, use
  a paid (always-on) plan. Free Postgres also expires after 30 days.
- **Scaling**: one instance is enough — it processes the full NSE F&O universe with
  rate-limited, batch API usage (~60s scan cycle).

## Useful endpoints

- `GET /api/health` — DB + service health (Render health check)
- `GET /api/scan` — latest two-stage scan payload
- `GET /api/universe` — live F&O universe state (`POST` forces a refresh)
- `POST /api/token` — set/validate the Upstox token (`DELETE` revokes)
