# SnapDeploy Keepalive (public wake API + URL ping)

**Discovery**: SnapDeploy has a PUBLIC wake API that doesn't require
login, cookies, or Cloudflare Turnstile bypass!

When a container is asleep, hitting its URL returns a 503 page with a
"Wake" button. That button calls:

```
POST https://snapdeploy.dev/api/public/wake/{subdomain}
```

Returns 200 immediately and starts the container in the background.
No auth headers needed.

## How it works

Every 10 minutes:

```
1. Ping container URL (https://vip012.containers.snapdeploy.dev/start-nz)
   ├─ HTTP 200 → container awake, agent already running → done
   └─ HTTP 503 → container asleep → continue

2. Call public wake API:
   POST https://snapdeploy.dev/api/public/wake/vip012
   Returns: { "status": "STARTING", "containerId": "..." }

3. Poll container URL every 15s (up to 120s) until it returns 200

4. Hit /start-nz to ensure nezha agent is started
```

## Why this works without auth

The SnapDeploy "wake" page (returned on 503) is what users see in
their browser when visiting a sleeping container's URL. The wake
button on that page calls the public API - no login needed because
the subdomain itself is the "auth" (only the container owner can
deploy to that subdomain).

## Setup

### Step 1: (Optional) Set repository variables

Default values are already set for the vip012 container. To use a
different container, set these repository variables:

Repo -> Settings -> Secrets and variables -> Actions -> Variables tab

| Variable | Default | Example |
|---|---|---|
| `KEEPALIVE_URL` | `https://vip012.containers.snapdeploy.dev/start-nz` | `https://your-sub.containers.snapdeploy.dev/start-nz` |
| `SNAPDEPLOY_SUBDOMAIN` | `vip012` | `your-sub` |

### Step 2: Enable the workflow

1. Repo -> Actions tab
2. If workflows are paused, click "I understand my workflows..."
3. Find "SnapDeploy Keepalive"
4. "Run workflow" to test manually

## Verifying it works

Check workflow logs - each run should show one of:

### Container already awake
```
=== Step 1: Check container status ===
Ping HTTP: 200
✓ Container is awake
{"code":0,"msg":"ok"}
Hitting /start-nz for agent keep-alive...
  /start-nz HTTP: 200
```

### Container was asleep, woke it up
```
=== Step 1: Check container status ===
Ping HTTP: 503

=== Step 2: Container not responding (HTTP 503), waking up ===
Wake API HTTP: 200
Wake response: {"subdomain":"vip012","message":"Container wake initiated","containerId":"c5c21126-...","status":"STARTING"}

=== Step 3: Waiting for container to start (up to 120s) ===
--- Check 1 at 15s ---
HTTP: 503
--- Check 2 at 30s ---
HTTP: 503
--- Check 3 at 45s ---
HTTP: 503
--- Check 4 at 60s ---
HTTP: 200
✓ Container is awake!
{"code":0,"msg":"ok"}
Hitting /start-nz for agent start...
  /start-nz HTTP: 200
```

## Schedule

- Default: every 10 minutes (`*/10 * * * *`)
- SnapDeploy sleeps after 15 min idle, so 10 min interval prevents sleep entirely
- GitHub Actions cron may delay 5-10 min during peak hours, still safe

## Cost

- SnapDeploy: $0 (free plan)
- GitHub Actions: $0 (within free tier, ~10-30 min/month)
- **Total: $0/month for 24/7 uptime**

## Files

- `.github/workflows/snapdeploy-api.yml` - the workflow
- `.github/KEEPALIVE.md` - this file

## Disabling

- Delete `.github/workflows/snapdeploy-api.yml`, OR
- Actions tab -> select workflow -> "..." menu -> "Disable workflow"

## Troubleshooting

### Wake API returns 404
- Wrong subdomain. Check `SNAPDEPLOY_SUBDOMAIN` variable.
- Default is `vip012` - change if your container has a different subdomain.

### Wake API returns 429
- Rate limited. SnapDeploy limits wake API calls.
- Increase cron interval (e.g. `*/15 * * * *` is the max safe value).

### Wake API returns 402
- Free plan deploy limit reached (5 deploys per 12 hours).
- Wait or upgrade. Note: wake != deploy, but SnapDeploy may count
  excessive wake calls against the daily deploy limit.

### Container never wakes up (HTTP 503 forever)
- Check SnapDeploy dashboard - container may be in error state
- Try manual "Wake" button in dashboard
- Check container logs for startup errors

### URL ping always fails (HTTP 000)
- Network issue from GitHub runner
- Verify URL is correct in `KEEPALIVE_URL` variable
