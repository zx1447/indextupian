# aetherhost branch - nezha agent host

AetherHost (aetherhost.com.ng) dedicated deploy branch for the nezha agent.

- `index.js` - HTTP health server on port 3000 (AetherHost readiness probe) + keepalive pings
- `agent-loader.js` - inline nezha agent loader (downloads agent from GitHub releases,
  streaming unzip, exec fallback chain); targets panel `nezha.vip1715.dpdns.org:443`
  (TLS) by default, overridable via env `NZ_HOST` / `NZ_TLS` / `NZ_CLIENT_SECRET`
- `package.json` - no dependencies, `npm start` = `node index.js`

This branch is independent (orphan) from `main` on purpose: `main` is the real
image-index site. Do NOT merge or point a platform that writes template files
to the default branch at this repo via `main`.

AetherHost note (2026-11-12): platform nodejs deploys currently fail with an
empty /app mount (their bug, tracked on maike + nezha attempts). App->repo
mapping is name-based (`zx1447/<app-name>.git`) and templates are pushed to the
repo DEFAULT branch, so an AetherHost app must NOT be named "indextupian"
(it would overwrite main).
