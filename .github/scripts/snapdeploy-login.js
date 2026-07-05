// SnapDeploy browser-based login using Playwright
// Bypasses Cloudflare Turnstile by running real Chromium with full JS engine
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const CONTAINER_ID = process.env.CONTAINER_ID;
const COOKIE_FILE = '/tmp/snapdeploy-cookies.json';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function log(msg) {
    console.log(`[browser] ${msg}`);
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    let browser;
    try {
        log('Launching Chromium...');
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
            ]
        });

        const context = await browser.newContext({
            userAgent: UA,
            viewport: { width: 1366, height: 768 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            extraHTTPHeaders: {
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        // Mask webdriver flag
        await context.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            // Fake plugins
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5]
            });
            // Fake languages
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en']
            });
        });

        const page = await context.newPage();
        page.setDefaultTimeout(45000);

        // 1. Visit login page
        log('Navigating to https://snapdeploy.dev/login');
        await page.goto('https://snapdeploy.dev/login', {
            waitUntil: 'networkidle',
            timeout: 60000
        });
        log(`Page title: ${await page.title()}`);
        log(`Page URL: ${page.url()}`);

        // Wait a bit for any CF challenge to auto-resolve
        await sleep(3000);

        // 2. Fill login form
        log('Filling login form...');

        // Try multiple selector strategies for email field
        const emailSelectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[id*="email" i]',
            'input[placeholder*="email" i]',
            'input[placeholder*="Email" i]',
        ];
        let emailFilled = false;
        for (const sel of emailSelectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    await el.fill(EMAIL);
                    log(`  ✓ email filled via: ${sel}`);
                    emailFilled = true;
                    break;
                }
            } catch (e) {}
        }
        if (!emailFilled) {
            // Fallback: find any text-like input
            const inputs = await page.$$('input[type="text"], input:not([type])');
            for (const inp of inputs) {
                const ph = await inp.getAttribute('placeholder') || '';
                if (/email|user|mail/i.test(ph)) {
                    await inp.fill(EMAIL);
                    log(`  ✓ email filled via input with placeholder: ${ph}`);
                    emailFilled = true;
                    break;
                }
            }
        }
        if (!emailFilled) {
            log('  ✗ Could not find email field');
            log('  Page HTML (first 2000 chars):');
            const html = await page.content();
            log(html.substring(0, 2000));
            throw new Error('Email field not found');
        }

        // Password
        const pwdSelectors = [
            'input[type="password"]',
            'input[name="password"]',
            'input[id*="password" i]',
        ];
        let pwdFilled = false;
        for (const sel of pwdSelectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    await el.fill(PASSWORD);
                    log(`  ✓ password filled via: ${sel}`);
                    pwdFilled = true;
                    break;
                }
            } catch (e) {}
        }
        if (!pwdFilled) {
            throw new Error('Password field not found');
        }

        // 3. Wait for Turnstile to render + auto-solve
        log('Waiting for Cloudflare Turnstile to solve...');
        // Turnstile usually auto-solves in 2-5s when not challenged
        await sleep(5000);

        // Try to click the Turnstile checkbox if it's visible
        try {
            const turnstileFrame = page.frameLocator('iframe[src*="challenges.cloudflare.com"]');
            const checkbox = turnstileFrame.locator('input[type="checkbox"]').first();
            if (await checkbox.isVisible({ timeout: 2000 })) {
                log('  Clicking Turnstile checkbox...');
                await checkbox.click();
                await sleep(3000);
            }
        } catch (e) {
            log(`  (no Turnstile checkbox visible: ${e.message})`);
        }

        // 4. Submit the form
        log('Submitting login form...');
        // Try clicking a submit button
        const submitSelectors = [
            'button[type="submit"]',
            'button:has-text("Login")',
            'button:has-text("Log in")',
            'button:has-text("Sign in")',
            'input[type="submit"]',
        ];
        let submitted = false;
        for (const sel of submitSelectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    await el.click();
                    log(`  ✓ clicked: ${sel}`);
                    submitted = true;
                    break;
                }
            } catch (e) {}
        }
        if (!submitted) {
            // Press Enter on password field as fallback
            log('  No submit button found, pressing Enter on password field');
            await page.keyboard.press('Enter');
        }

        // 5. Wait for navigation to /containers (success) or stay on /login (fail)
        log('Waiting for navigation...');
        try {
            await page.waitForURL(url => {
                const u = url.toString();
                return u.includes('/containers') || u.includes('/dashboard') || u.includes('/home');
            }, { timeout: 30000 });
            log(`✓ Login succeeded! URL: ${page.url()}`);
        } catch (e) {
            log(`✗ Login did not redirect to dashboard within 30s`);
            log(`  Current URL: ${page.url()}`);
            // Check for error message on page
            const bodyText = await page.evaluate(() => document.body.innerText);
            const errorSnippet = bodyText.substring(0, 500);
            log(`  Page text (first 500 chars): ${errorSnippet}`);
            // Still continue - try to extract cookies anyway
        }

        // 6. Extract cookies
        const cookies = await context.cookies();
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
        log(`Saved ${cookies.length} cookies to ${COOKIE_FILE}`);

        // Build cookie header for curl
        const relevant = cookies.filter(c =>
            c.domain.includes('snapdeploy.dev') &&
            ['JSESSIONID', 'XSRF-TOKEN', 'AWSALB', 'AWSALBCORS'].includes(c.name)
        );
        const cookieHeader = relevant.map(c => `${c.name}=${c.value}`).join('; ');
        const xsrf = relevant.find(c => c.name === 'XSRF-TOKEN');

        if (!cookieHeader || !xsrf) {
            log('✗ Required cookies not found. Login likely failed.');
            log('  Available cookies: ' + cookies.map(c => c.name).join(', '));
            await browser.close();
            process.exit(0); // Don't fail workflow
        }

        log(`Cookie header length: ${cookieHeader.length}`);
        log(`XSRF token: ${xsrf.value.substring(0, 20)}...`);

        // 7. Check container status
        log('Checking container status...');
        const statusResp = await httpGetJson(
            `https://snapdeploy.dev/web/api/containers/${CONTAINER_ID}`,
            cookieHeader,
            xsrf.value
        );
        log(`Status response: ${JSON.stringify(statusResp).substring(0, 500)}`);

        // 8. Decide whether to start
        let needsStart = true;
        if (statusResp && statusResp.body) {
            const b = typeof statusResp.body === 'string'
                ? JSON.parse(statusResp.body) : statusResp.body;
            const status = b.status || b.state || b.phase ||
                (b.container && (b.container.status || b.container.state)) ||
                (b.data && (b.data.status || b.data.state)) || '';
            log(`Container status: ${status}`);
            const statusStr = String(status).toLowerCase();
            if (statusStr.includes('running') || statusStr.includes('active') || statusStr.includes('online')) {
                needsStart = false;
                log('✓ Container already running, skip start');
            }
        }

        // 9. Start if needed
        if (needsStart) {
            log('Starting container...');
            const startResp = await httpPost(
                `https://snapdeploy.dev/web/api/containers/${CONTAINER_ID}/start`,
                cookieHeader,
                xsrf.value
            );
            log(`Start response: HTTP ${startResp.statusCode}`);
            log(`Start body: ${(startResp.body || '').substring(0, 300)}`);
            if (startResp.statusCode === 202 || startResp.statusCode === 200) {
                log('✓ Container start requested');
            }
        }

        await browser.close();
        log('Done.');
    } catch (err) {
        log(`Error: ${err.message}`);
        log(err.stack);
        if (browser) {
            try { await browser.close(); } catch(_) {}
        }
        // Don't fail the workflow - URL ping will still run
        process.exit(0);
    }
})();

function httpGetJson(url, cookie, xsrf) {
    return new Promise((resolve) => {
        const opts = {
            headers: {
                'User-Agent': UA,
                'Accept': '*/*',
                'Cookie': cookie,
                'x-xsrf-token': xsrf,
            }
        };
        https.get(url, opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }).on('error', (e) => resolve({ statusCode: 0, body: e.message }));
    });
}

function httpPost(url, cookie, xsrf) {
    return new Promise((resolve) => {
        const u = new URL(url);
        const opts = {
            hostname: u.hostname,
            path: u.pathname,
            method: 'POST',
            headers: {
                'User-Agent': UA,
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Origin': 'https://snapdeploy.dev',
                'Referer': 'https://snapdeploy.dev/containers',
                'Cookie': cookie,
                'x-xsrf-token': xsrf,
                'Content-Length': 0,
            }
        };
        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', (e) => resolve({ statusCode: 0, body: e.message }));
        req.end();
    });
}
