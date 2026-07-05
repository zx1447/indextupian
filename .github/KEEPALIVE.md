# SnapDeploy Keepalive via GitHub Actions

This branch includes a GitHub Actions workflow that pings the deployed
SnapDeploy container every 3 minutes to prevent it from auto-sleeping.

## Why this is needed

SnapDeploy's free plan auto-sleeps containers after 15 minutes of no
incoming external traffic. The container's built-in `selfPing` only
hits `127.0.0.1` (localhost) which does NOT count as external traffic
on SnapDeploy. GitHub Actions runs on public GitHub servers, so its
requests count as real external traffic.

## How it works

```
GitHub Actions (every 3 min)
  ↓
GET https://vip012.containers.snapdeploy.dev/start-nz
  ↓
SnapDeploy sees external traffic -> resets 15-min sleep timer
  ↓
Container keeps running
  ↓
nezha agent stays online
```

## Setup

The workflow is **zero-config by default**. It will start running as
soon as you push this branch to GitHub.

### Default URL

The workflow is hardcoded to ping:
```
https://vip012.containers.snapdeploy.dev/start-nz
```

If you deploy to a different URL later, you have two options:

**Option A: Edit the workflow file** (`.github/workflows/keepalive.yml`)
Change the default value of `KEEPALIVE_URL` in the env block.

**Option B: Use a repository variable** (recommended - no code change)
1. Go to repo Settings -> Secrets and variables -> Actions
2. Switch to the "Variables" tab (not Secrets)
3. Click "New repository variable"
4. Name: `KEEPALIVE_URL`
5. Value: `https://your-new-url.example.com/start-nz`
6. The workflow will automatically use this value

## Verifying it runs

1. Go to the repo's **Actions** tab on GitHub
2. Click "Keepalive Ping" in the left sidebar
3. You should see a run every 3 minutes (with some delay during peak hours)
4. Each run should show `HTTP code: 200` and the response body
   `{"code":0,"msg":"ok"}` (or `{"code":-1,"msg":"error"}` if the agent
   failed to start - check container logs in that case)

## Notes

- **Public vs Private repo**: This workflow uses ~480 runs/month * ~10
  seconds = ~80 minutes. Public repos have unlimited free minutes.
  Private repos get 2000 free minutes/month, so this is well within the
  limit.
- **GitHub cron accuracy**: GitHub Actions cron is "best effort". During
  peak hours, runs may be delayed 5-10 minutes. This is still well under
  SnapDeploy's 15-minute sleep threshold, so the container stays awake.
- **Manual trigger**: You can manually trigger the workflow from the
  Actions tab (click "Run workflow") for testing.
- **Multiple URLs**: If you have multiple SnapDeploy containers, copy
  the workflow file and change the URL (or extend the script to ping
  multiple URLs).

## Cost

- SnapDeploy: $0 (free plan)
- GitHub Actions: $0 (within free tier)
- Total: $0/month for 24/7 uptime

## Disabling

If you want to stop the keepalive (e.g. you upgraded to SnapDeploy
Always-On), either:
1. Delete `.github/workflows/keepalive.yml`
2. Or go to Actions tab -> select "Keepalive Ping" -> click the "..." menu -> "Disable workflow"
