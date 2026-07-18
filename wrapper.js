const fs = require('fs');
const { spawn } = require('child_process');

// 从 env 读配置
const server = process.env.NZ_SERVER || 'nz.zxydk1715.dpdns.org:443';
const tls = process.env.NZ_TLS || 'true';
const secret = process.env.NZ_CLIENT_SECRET || '';
const debug = process.env.NZ_DEBUG || 'false';

// 生成 config.yml
const config = `server: ${server}
client_secret: ${secret}
tls: ${tls}
disable_auto_update: true
disable_force_update: true
disable_command_execute: false
skip_connection_count: false
debug: ${debug}
disable_send_query: false
gpu: false
report_delay: 3
`;

fs.writeFileSync('/app/config.yml', config);
console.log('[wrapper] config.yml generated');
console.log(config);

// 启动 nezha-agent
console.log('[wrapper] starting nezha-agent...');
const child = spawn('/app/nezha-agent', ['-c', '/app/config.yml'], { stdio: 'inherit' });

child.on('exit', (code, signal) => {
    console.log(`[wrapper] nezha-agent exited code=${code} signal=${signal}`);
    process.exit(code || 0);
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
