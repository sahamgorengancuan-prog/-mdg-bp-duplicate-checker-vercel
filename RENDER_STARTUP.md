# Render runtime — setup for the SAME repository and revision

This repo supports Vercel serverless functions and Render Node web service.
`package.json` already had `start: node server.js`; a Render log saying
`yarn start: Command "start" not found` proves Render is **not reading this
package.json** in that deploy. The fix is checking Render's actual connected
repository, branch, root directory and deployed commit, not merely editing a
different repository.

Existing Render service settings:
- Repository: sahamgorengancuan-prog/-mdg-bp-duplicate-checker-vercel
- Branch: main
- Root Directory: empty (root of this repository)
- Runtime: Node; Build Command: yarn install; Start Command: yarn start
- Health Check Path: /api/health (requires valid Sheets/OAuth environment)
- PORT: leave unset; Render injects it
- SHEET_ID and GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN: set in Render
  environment, never in Git or screenshots. Check request access-control
  environment settings if configured.

Optional `render.yaml` is for Blueprint users; it is **not** automatically
applied to an already-existing manually configured Render Web Service.
Creating a Blueprint may create a *separate* service. Configure the existing
service explicitly instead.

CI runs `yarn smoke` and checks that `yarn start` binds to PORT, serves
the frontend, returns the engine fingerprint from /api/health without real
credentials, and does not expose .env. CI does not access the live company
spreadsheet. After deploying, visit the actual service hostname's /api/health;
require engine_version 2026-09-24-memory-full-scan-v15 and sheet_ok true.
In dual mode also require `search_backend: MEMORY_FULL_SCAN` and `memory.records`
equal to the BP count (see MEMORY_FULL_SCAN_V15.md). Right after boot the health
check answers 503 `warming` until the snapshot is in memory; Render keeps the
previous instance serving until it turns 200.
