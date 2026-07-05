# SnapDeploy Keepalive Setup

## What this workflow does

Every 5 minutes, GitHub Actions runs `.github/workflows/snapdeploy-api.yml`:

```
1. Detect: GET https://vip012.containers.snapdeploy.dev/api/v1/status
   ├─ HTTP 200 → container is awake, skip to step 3
   └─ HTTP 503 → container is asleep, continue to step 2

2. Wake: POST https://snapdeploy.dev/api/public/wake/vip012
   Returns 200 immediately, container starts in background
   Poll every 15s up to 120s until container responds 200

3. Anti-sleep pings: hit multiple endpoints to reset idle timer
   - GET /                    (home page)
   - GET /start-nz            (also keeps nezha agent alive)
   - GET /api/v1/status       (also reports agent status)
   - GET /programs?_t=...     (varies traffic pattern)
```

## Why this prevents the 15-min idle sleep

SnapDeploy's free plan auto-sleeps containers after 15 minutes of no
incoming external traffic. Each request from GitHub Actions counts as
"external traffic" and resets the 15-min timer. With 5-min interval,
the container never goes 15 min without traffic, so it never sleeps.

The "anti-sleep pings" step hits multiple distinct endpoints because
SnapDeploy may track activity per-path or per-session. Hitting
multiple endpoints maximizes the chance of being counted as active.

## Problem: GitHub Actions schedule may not auto-fire

GitHub has a known bug: on new public repos, the `schedule` trigger
is registered but doesn't actually fire until... sometimes hours,
sometimes days, sometimes never without manual intervention.

## Solution: External cron triggers workflow_dispatch

Use a free external cron service to call the GitHub API every 5
minutes. This bypasses the schedule bug entirely.

### Option A: cron-job.org (recommended)

1. Register at https://cron-job.org (free, no credit card)

2. Create a new cron job:
   - **Title**: SnapDeploy Keepalive
   - **URL**:
     ```
     https://api.github.com/repos/zx1447/indextupian/actions/workflows/snapdeploy-api.yml/dispatches
     ```
   - **Execution schedule**: Every 5 minutes (`*/5 * * * *`)
   - **Request method**: POST
   - **Headers**:
     ```
     Authorization: token YOUR_GITHUB_PAT
     Accept: application/vnd.github+json
     Content-Type: application/json
     ```
   - **Body**:
     ```json
     {"ref":"snap","inputs":{}}
     ```
   - **Request timeout**: 30 seconds

3. Save. cron-job.org will call the API every 5 minutes, triggering
   the workflow which detects + wakes + pings SnapDeploy.

### Option B: UptimeRobot (simpler but less reliable)

1. Register at https://uptimerobot.com (free, 50 monitors)

2. Add new monitor:
   - **Monitor type**: HTTP(s)
   - **Friendly name**: SnapDeploy Keepalive
   - **URL**: `https://vip012.containers.snapdeploy.dev/start-nz`
   - **Monitoring interval**: 5 minutes

UptimeRobot directly pings your container every 5 min, which resets
SnapDeploy's idle timer. Limitation: if container is already asleep,
UptimeRobot's 30s timeout may not be enough for the 60s cold-start.

### Option C: GitHub PAT self-trigger (advanced)

Use a PAT to let the workflow trigger itself. Requires:
1. Generate PAT at https://github.com/settings/tokens/new?scopes=repo
2. Add as repo secret `PAT_TOKEN`
3. Manually trigger once to bootstrap the chain

## How to know if schedule is firing

Check https://github.com/zx1447/indextupian/actions
- Each run shows "event=schedule" if auto-fired
- Each run shows "event=workflow_dispatch" if triggered via API
- If you only see workflow_dispatch runs, schedule isn't firing yet
  and you need Option A or B above

## Cost

All options are $0:
- SnapDeploy: $0 (free plan)
- cron-job.org: $0 (free)
- UptimeRobot: $0 (free 50 monitors)
- GitHub Actions: $0 (within free tier)

## Verify it works

After setup:
1. SnapDeploy dashboard shows "Last active" updating every 5 min
2. Container status shows "Running" (never "Sleeping")
3. nezha dashboard shows the agent online continuously
4. GitHub Actions page shows a new run every 5 min

## Customize

If you deploy to a different subdomain, set these repository variables
(Settings -> Secrets and variables -> Actions -> Variables):

| Variable | Default | Example |
|---|---|---|
| `KEEPALIVE_URL` | `https://vip012.containers.snapdeploy.dev/start-nz` | `https://yours.containers.snapdeploy.dev/start-nz` |
| `SNAPDEPLOY_SUBDOMAIN` | `vip012` | `yours` |
