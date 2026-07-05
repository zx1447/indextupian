# SnapDeploy Keepalive (browser login + API + URL ping)

GitHub Actions runs on a full Ubuntu VM with Chromium, so we can do
real browser-based login to bypass Cloudflare Turnstile.

## How it works

Every 10 minutes:

```
1. Install Playwright + Chromium on GitHub Actions runner
2. Launch headless Chromium with anti-detection patches:
   - Remove webdriver flag
   - Fake plugins/languages
   - Realistic User-Agent
   - Full viewport
3. Navigate to https://snapdeploy.dev/login
4. Wait for Cloudflare Turnstile widget to auto-solve (~5s)
5. Fill email + password
6. Click submit (or press Enter)
7. Wait for redirect to /containers (login success)
8. Extract JSESSIONID + XSRF-TOKEN + AWSALB cookies
9. GET /web/api/containers/{id} to check status
10. If not running: POST /web/api/containers/{id}/start
11. Always: curl public URL /start-nz (core keepalive)
```

If browser login fails (Turnstile challenges harder, IP flagged, etc.),
the workflow still runs Step 11 (URL ping) which alone is sufficient
to keep the container awake (10 min interval < 15 min sleep threshold).

## Setup

### Step 1: Get your container ID

SnapDeploy dashboard -> click your container -> URL contains the ID:
```
https://snapdeploy.dev/containers/c5c21126-7c9f-423d-860d-864c00c8bd8c
                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

### Step 2: Add GitHub secrets

Repo -> Settings -> Secrets and variables -> Actions -> New repository secret

| Secret name | Value |
|---|---|
| `SNAPDEPLOY_EMAIL` | Your SnapDeploy login email |
| `SNAPDEPLOY_PASSWORD` | Your SnapDeploy password |
| `SNAPDEPLOY_CONTAINER_ID` | Your container UUID |

### Step 3: Enable the workflow

1. Repo -> Actions tab
2. If paused: "I understand my workflows, go ahead and enable them"
3. Find "SnapDeploy Keepalive"
4. "Run workflow" to test manually

### Step 4: (Optional) Custom ping URL

Repo -> Settings -> Secrets and variables -> Variables tab -> New variable

| Variable name | Value |
|---|---|
| `KEEPALIVE_URL` | `https://your-url/start-nz` |

## Verifying it works

Check workflow logs - each run should show:

```
[browser] Launching Chromium...
[browser] Navigating to https://snapdeploy.dev/login
[browser] Page title: SnapDeploy Login
[browser] Filling login form...
[browser]   ✓ email filled via: input[type="email"]
[browser]   ✓ password filled via: input[type="password"]
[browser] Waiting for Cloudflare Turnstile to solve...
[browser] Submitting login form...
[browser]   ✓ clicked: button[type="submit"]
[browser] Waiting for navigation...
[browser] ✓ Login succeeded! URL: https://snapdeploy.dev/containers
[browser] Saved 8 cookies to /tmp/snapdeploy-cookies.json
[browser] Checking container status...
[browser] Container status: running
[browser] ✓ Container already running, skip start
[browser] Done.

=== Core keepalive: URL ping ===
HTTP: 200
Response: {"code":0,"msg":"ok"}
✓ URL ping succeeded
```

## If browser login fails

Symptoms in log:
```
[browser] ✗ Login did not redirect to dashboard within 30s
```
or
```
[browser] Required cookies not found. Login likely failed.
```

Possible causes:
1. **Cloudflare Turnstile harder challenge** - GitHub IP got challenged
   - Wait for next run (different runner IP)
   - Or accept Layer 3 only (still keeps container awake)
2. **Wrong email/password** - verify secrets
3. **SnapDeploy changed login form** - update selectors in
   `.github/scripts/snapdeploy-login.js`
4. **Account locked** - try manual login in browser to unlock

## Files

- `.github/workflows/snapdeploy-api.yml` - workflow definition
- `.github/scripts/snapdeploy-login.js` - Playwright login script
- `.github/KEEPALIVE.md` - this file

## Cost

- SnapDeploy: $0 (free plan)
- GitHub Actions: $0 (within free tier)
  - Per run: ~2-3 min (browser install + login + ping)
  - Per month: ~432 runs * 3 min = ~22 hours (well within 2000 free min)
- **Total: $0/month for 24/7 uptime**

## Disabling

- Delete `.github/workflows/snapdeploy-api.yml`, OR
- Actions tab -> select workflow -> "..." menu -> "Disable workflow"

## Schedule tuning

Default: `*/10 * * * *` (every 10 minutes)

If you want more frequent checks (e.g. every 5 min):
1. Edit `.github/workflows/snapdeploy-api.yml`
2. Change cron to `*/5 * * * *`
3. Note: doubles GitHub Actions usage (still within free tier)

If you want less frequent (e.g. every 15 min):
- Don't. 15 min = SnapDeploy's sleep threshold. Use 10 min max.

## Security notes

- Email/password stored as GitHub secrets (only visible to repo admin)
- Cookies extracted at runtime, never persisted to repo
- Workflow logs mask secret values automatically
- Browser runs on ephemeral GitHub runner, destroyed after each run
