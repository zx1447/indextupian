# SnapDeploy Keepalive (API + URL dual-layer)

This branch includes a GitHub Actions workflow that keeps your
SnapDeploy container awake 24/7 on the free plan.

## Strategy: two layers, both run every 3 minutes

### Layer 1 (primary): SnapDeploy internal API call

Calls the same internal API endpoint that the dashboard "Wake" button
uses. Force-starts the container immediately, no 60-second cold-start
wait.

```
POST https://snapdeploy.dev/web/api/containers/{id}/start
```

### Layer 2 (fallback): public URL ping

Curls `https://vip012.containers.snapdeploy.dev/start-nz` from
GitHub's public IPs. This counts as external traffic for SnapDeploy's
15-minute sleep timer, and also triggers a wake-up if the container
is asleep.

If Layer 1 fails (e.g. session expired), Layer 2 still works as
backup.

## Setup

### Step 1: Get your container ID

Open SnapDeploy dashboard -> click your container -> look at URL.
The UUID in the URL is your container ID:
```
https://snapdeploy.dev/containers/c5c21126-7c9f-423d-860d-864c00c8bd8c
                                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                    this is the container ID
```

### Step 2: Capture cookies + XSRF token

1. Open https://snapdeploy.dev and log in
2. Open browser DevTools (F12) -> Network tab
3. Go to your containers page
4. Click the "Wake" (醒醒) button on a sleeping container
5. Find the POST request to `/web/api/containers/{id}/start`
6. Right-click the request -> Copy -> Copy as cURL (bash)
7. From the cURL command, extract these 3 values:

**a) Container ID** - from the URL
```
c5c21126-7c9f-423d-860d-864c00c8bd8c
```

**b) Full Cookie header** - from the `-H 'cookie: ...'` flag
```
_ga=...; JSESSIONID=...; XSRF-TOKEN=...; AWSALB=...; AWSALBCORS=...
```
Copy the entire string after `cookie: ` (everything between the quotes).

**c) x-xsrf-token header** - from the `-H 'x-xsrf-token: ...'` flag
```
eDe6yVhZQv5WrPYnf8HHLqq7T7a0x67ZrCzL30lFK-ONUIF7GwaMqGlvepx7z5MXHezzG57eYteG85r0yhz65yogG4C_aLFI
```

### Step 3: Add secrets to GitHub repo

Go to: GitHub repo -> Settings -> Secrets and variables -> Actions ->
New repository secret

Create these 3 secrets:

| Secret name | Value |
|---|---|
| `SNAPDEPLOY_CONTAINER_ID` | Your container UUID (e.g. `c5c21126-...`) |
| `SNAPDEPLOY_COOKIE` | The full cookie string from step 2b |
| `SNAPDEPLOY_XSRF_TOKEN` | The x-xsrf-token value from step 2c |

### Step 4: Enable the workflow

1. Go to repo -> Actions tab
2. If you see "Workflows aren't being run on this branch", click
   "I understand my workflows, go ahead and enable them"
3. Find "SnapDeploy Keepalive (API + URL)" in the left sidebar
4. Click "Run workflow" to test it manually

### Step 5: (Optional) Change the ping URL

If your SnapDeploy URL changes, set a repository variable:
- Settings -> Secrets and variables -> Actions -> Variables tab
- New repository variable
- Name: `KEEPALIVE_URL`
- Value: `https://your-new-url/start-nz`

## Verifying it works

1. **Workflow runs**: Actions tab should show a run every 3 minutes
2. **Layer 1 success**: Logs should show `API HTTP code: 202`
3. **Layer 2 success**: Logs should show `URL HTTP code: 200` and
   response body `{"code":0,"msg":"ok"}`
4. **Container status**: SnapDeploy dashboard should show "Running"
   (not "Sleeping")
5. **Last active time**: Should update every 3 minutes

## When sessions expire

The `JSESSIONID` cookie may expire after server-side session timeout
(usually 24 hours of inactivity, but we keep it active by calling
every 3 minutes - so it should last indefinitely).

If Layer 1 starts failing with HTTP 401/403:
1. Re-capture the cookies (Step 2 above)
2. Update the `SNAPDEPLOY_COOKIE` and `SNAPDEPLOY_XSRF_TOKEN` secrets
3. Layer 2 (URL ping) keeps working as backup

**Symptom of expired session**: Workflow log shows
`::warning::Auth failed (HTTP 401). Session may have expired.`

## Cost

- SnapDeploy: $0 (free plan)
- GitHub Actions: $0 (within free tier, ~80 min/month for public repo)
- **Total: $0/month for 24/7 uptime**

## Files

- `.github/workflows/snapdeploy-api.yml` - the workflow
- `.github/KEEPALIVE.md` - this file

## Disabling

To stop keepalive:
- Delete `.github/workflows/snapdeploy-api.yml`, OR
- Actions tab -> "SnapDeploy Keepalive (API + URL)" -> "..." menu -> "Disable workflow"
