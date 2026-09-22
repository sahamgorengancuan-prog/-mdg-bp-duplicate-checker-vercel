# Verify the deployed API and local exact index before judging an exact name/address check

The repository previously contained the exact-index patch on `main`, but that proves neither that the hosting service deployed that commit nor that the local Python sync populated EXACT_INDEX. The last user-shared Sheet snapshot (2026-09-22 13:15:18 Asia/Jakarta) preceded the patched local install and therefore cannot validate the two new tabs.

## Local, Windows read-only proof

Run in the existing application directory with the same `.env` and local OAuth credentials as the sync BAT:

```bat
py tools\audit_exact_name_address.py <BP_ID>
```

The audit checks META READY, exact index version/count, BP_DATABASE row(s), hash/shard, exact-index row pointer and sync ID. It does not sync or write any business data. Do not commit `.env`, OAuth JSON or local audit output.

If META is not READY or exact index version/count is wrong, run the patched local BAT (`bats\fix_dependencies_and_sync.bat`) to rebuild the indexes before testing or deploying the API.

## Live API verification

On the *actual website hostname* (Render, Vercel, or other host), GET `/api/health` and check:

- `engine_version: 2026-09-22-exact-index-v2`
- `exact_index_ready: true`, `sheet_ok: true`
- `meta.sync_state: READY`, `meta.exact_index_version: "1"`
- `meta.total_exact_index_rows == meta.total_bp_rows`
- `meta.sync_id` agrees with local read-only audit

Then POST `/api/check` with the affected name and address, leaving KTP empty. `exact_lookup` reports whether exact lookup ran, whether the hash shard exists, the number of shard rows, index hash hits and verified results. Do not send OAuth tokens or raw KTP in support messages. If the engine fingerprint is missing or different, the application is not running this release. Confirm the deployed service's GitHub repository, branch, root directory, commit, and deployment status. GitHub `main` updates do not automatically prove Render/Vercel has deployed.

`MAX_CANDIDATES` does not affect exact name+address matching. Never increase it to solve an exact-index or deployment mismatch. An old/unready snapshot must fail with HTTP 503; never treat this as PASS.
