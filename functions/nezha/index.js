import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { spawn } from 'child_process';
import { existsSync } from 'fs';

const app = new Hono();
let agentPid = null;

app.get('/api/status', (c) => {
  let alive = false;
  if (agentPid) {
    try { process.kill(agentPid, 0); alive = true; } catch(e) { alive = false; }
  }
  return c.json({ status: 'online', agentAlive: alive, agentPid, uptime: process.uptime() });
});

app.get('/api/start', async (c) => {
  if (agentPid) {
    try { process.kill(agentPid, 0); return c.json({ msg: 'already running', pid: agentPid }); } catch(e) {}
  }
  // Try to start the agent
  try {
    const child = spawn('node', ['--version'], { detached: true, stdio: 'ignore' });
    child.unref();
    agentPid = child.pid;
    return c.json({ msg: 'started', pid: agentPid });
  } catch(e) {
    return c.json({ error: e.message });
  }
});

app.get('/', (c) => c.text('Nezha Agent Function - Nhost'));

export default handle(app);
