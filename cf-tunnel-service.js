/* cf-tunnel-service.js — CF 隧道节点生成器 v2
 * 运行于 Unikraft html-static-dal (official/node, LOADER 拉取本文件并 eval)
 * 功能: 纯JS VLESS-over-WS 后端 + cloudflared 隧道管理(临时/固定) + 生成器页面
 * 模式1: 什么都不填 -> trycloudflare.com 临时隧道节点
 * 模式2: 填固定域名+Token -> 自定义域名固定隧道节点
 */
"use strict";
const http = require("http"), net = require("net"), crypto = require("crypto"),
      fs = require("fs"), spawn = require("child_process").spawn, tls = require("tls"),
      Readable = require("stream").Readable;

const PORT = +(process.env.PORT || 8080);
const PATH_DEF = (process.env.VLESS_PATH || "vless").replace(/^\/+|\/+$/g, "");
const CF = "/tmp/cloudflared";

const state = {
  tempUUID: process.env.VLESS_UUID || crypto.randomUUID(),
  uuids: new Set(),
  tunnel: null,          // {type:'temp'|'fixed', proc, domain, startedAt, restarts}
  fixed: null,           // {token, domain, uuid, path}
  log: [], lastError: "",
};
state.uuids.add(state.tempUUID.replace(/-/g, ""));

function log(s) {
  const line = new Date().toISOString().slice(11, 19) + " " + String(s).slice(0, 300);
  state.log.push(line); if (state.log.length > 200) state.log.shift();
  console.log(line);
}

/* ---------------- 纯JS WebSocket ---------------- */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const wsAccept = k => crypto.createHash("sha1").update(k + WS_GUID).digest("base64");

class WS {
  constructor(sock) {
    this.sock = sock; this.buf = null; this.cur = null; this.closed = false;
    this.onmessage = null; this.onend = null;
    sock.on("data", d => this._feed(d));
    sock.on("error", () => this.close());
    sock.on("close", () => { if (!this.closed) { this.closed = true; if (this.onend) this.onend(); } });
    sock.on("end", () => { if (!this.closed) { this.closed = true; if (this.onend) this.onend(); } });
  }
  _feed(d) {
    this.buf = this.buf ? Buffer.concat([this.buf, d]) : d;
    for (;;) { const f = this._frame(); if (!f) break; this._handle(f); }
  }
  _frame() {
    const b = this.buf; if (!b || b.length < 2) return null;
    const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    let mask = null;
    if (masked) { if (b.length < off + 4) return null; mask = b.slice(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    let p = b.slice(off, off + len); this.buf = b.slice(off + len);
    if (masked && len) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
    return { fin, op, payload: p };
  }
  _handle(f) {
    if (f.op === 8) { this._raw(Buffer.from([0x88, 0x00])); this._gone(); return; }
    if (f.op === 9) { this._send(10, f.payload); return; }
    if (f.op === 10) return;
    if (f.op === 1 || f.op === 2 || f.op === 0) {
      this.cur = this.cur ? Buffer.concat([this.cur, f.payload]) : f.payload;
      if (this.cur.length > 16 * 1024 * 1024) { this.close(); return; }
      if (f.fin) { const m = this.cur; this.cur = null; if (this.onmessage) this.onmessage(m); }
    }
  }
  _send(op, payload) {
    if (this.closed) return;
    const len = payload.length; let h;
    if (len < 126) { h = Buffer.allocUnsafe(2); h[0] = 0x80 | op; h[1] = len; }
    else if (len < 65536) { h = Buffer.allocUnsafe(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.allocUnsafe(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    try { this.sock.write(Buffer.concat([h, payload])); } catch (e) {}
  }
  send(d) { this._send(2, d); }
  _raw(b) { try { this.sock.write(b); } catch (e) {} }
  _gone() { this.closed = true; try { this.sock.destroy(); } catch (e) {} if (this.onend) this.onend(); }
  close() { if (this.closed) return; this._raw(Buffer.from([0x88, 0x00])); this._gone(); }
}

/* ---------------- VLESS over WS ---------------- */
function upgradeHandler(req, sock, head) {
  let path = "/"; try { path = new URL(req.url, "http://x").pathname; } catch (e) {}
  const q = path.replace(/^\/+/, "").replace(/\/+$/, "").split("?")[0];
  const allowed = new Set([PATH_DEF]);
  if (state.fixed && state.fixed.path) allowed.add(state.fixed.path.replace(/^\/+|\/+$/g, ""));
  const key = req.headers["sec-websocket-key"];
  if (!allowed.has(q) || !key) { try { sock.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); sock.destroy(); } catch (e) {} return; }
  let proto = "", early = null;
  const p = req.headers["sec-websocket-protocol"];
  if (p) { const t = p.split(",")[0].trim(); if (t) { proto = t; try { early = Buffer.from(t, "base64"); } catch (e) {} } }
  const hdr = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + wsAccept(key)];
  if (proto) hdr.push("Sec-WebSocket-Protocol: " + proto);
  try { sock.write(hdr.join("\r\n") + "\r\n\r\n"); } catch (e) { return; }
  const ws = new WS(sock);
  if (early && early.length) ws._acc = early;
  ws.onmessage = buf => {
    if (ws._target) { try { ws._target.write(buf); } catch (e) {} return; }
    ws._acc = ws._acc ? Buffer.concat([ws._acc, buf]) : buf;
    parseVless(ws);
  };
  if (ws._acc) parseVless(ws);
}

function parseVless(ws) {
  const b = ws._acc; if (!b || b.length < 19) return;
  const ver = b[0], uuid = b.slice(1, 17).toString("hex");
  if (ver !== 0 || !state.uuids.has(uuid)) { log("vless 拒绝: uuid/版本不符"); ws.close(); return; }
  const optLen = b[17]; if (b.length < 22 + optLen) return;
  const cmd = b[18 + optLen], port = b.readUInt16BE(19 + optLen), atype = b[21 + optLen];
  let off = 22 + optLen, host;
  if (atype === 1) { if (b.length < off + 4) return; host = [b[off], b[off + 1], b[off + 2], b[off + 3]].join("."); off += 4; }
  else if (atype === 2) { const dl = b[off]; if (b.length < off + 1 + dl) return; host = b.slice(off + 1, off + 1 + dl).toString(); off += 1 + dl; }
  else if (atype === 3) { if (b.length < off + 16) return; const h = []; for (let i = 0; i < 16; i += 2) h.push(b.slice(off + i, off + i + 2).toString("hex")); host = h.join(":"); off += 16; }
  else { ws.close(); return; }
  if (cmd !== 1) { log("vless 拒绝: 仅支持TCP(cmd=" + cmd + ")"); ws.close(); return; }
  const payload = b.slice(off); ws._acc = null;
  const t = net.connect(port, host, () => {
    ws.send(Buffer.from([0, 0]));               // VLESS response header
    if (payload.length) try { t.write(payload); } catch (e) {}
  });
  ws._target = t;
  t.on("data", d => ws.send(d));
  t.on("error", e => { log("目标连接错误 " + host + ":" + port + " " + e.message); ws.close(); });
  t.on("close", () => ws.close());
  ws.onend = () => { try { t.destroy(); } catch (e) {} };
  log("vless 连接 -> " + host + ":" + port);
}

/* ---------------- cloudflared 管理 ---------------- */
function caFile() {
  try {
    if (!fs.existsSync("/tmp/ca-certificates.crt"))
      fs.writeFileSync("/tmp/ca-certificates.crt", tls.rootCertificates.join("\n"));
    return "/tmp/ca-certificates.crt";
  } catch (e) { return null; }
}
async function ensureCf() {
  try { if (fs.existsSync(CF) && fs.statSync(CF).size > 30 * 1024 * 1024) return true; } catch (e) {}
  try { fs.unlinkSync(CF); } catch (e) {}
  log("开始下载 cloudflared (约60MB, 首次较慢)...");
  const urls = ["https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"];
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: "follow" });
      if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
      const w = fs.createWriteStream(CF);
      await new Promise((ok, no) => { Readable.fromWeb(r.body).on("error", no).pipe(w); w.on("finish", ok); w.on("error", no); });
      try { fs.chmodSync(CF, 0o755); } catch (e) {}
      log("cloudflared 下载完成 " + fs.statSync(CF).size + " bytes");
      return true;
    } catch (e) { log("下载失败: " + e.message); try { fs.unlinkSync(CF); } catch (e2) {} }
  }
  return false;
}
function childEnv() {
  const env = Object.assign({}, process.env);
  const ca = caFile(); if (ca) { env.SSL_CERT_FILE = ca; env.SSL_CERT_DIR = "/tmp"; }
  return env;
}
function pipeLog(proc, tag) {
  const f = d => String(d).split(/\r?\n/).forEach(l => {
    if (!l.trim()) return; log("[" + tag + "] " + l.trim().slice(0, 280));
    if (state.tunnel && state.tunnel.type === "temp" && !state.tunnel.domain) {
      const m = l.match(/https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i);
      if (m) { state.tunnel.domain = m[0].replace(/^https:\/\//, ""); log("临时域名获取成功: " + state.tunnel.domain); }
    }
  });
  proc.stdout.on("data", f); proc.stderr.on("data", f);
}
function stopTunnel(reason) {
  const t = state.tunnel; if (!t) return;
  state.tunnel = null;
  try { t.proc.kill("SIGKILL"); } catch (e) {}
  log("隧道已停止" + (reason ? "(" + reason + ")" : ""));
}
async function startTemp() {
  if (state.tunnel) return { ok: false, err: "已有隧道在运行，请先停止" };
  if (!(await ensureCf())) { state.lastError = "cloudflared 下载失败，详见日志"; return { ok: false, err: state.lastError }; }
  let proc;
  try {
    proc = spawn(CF, ["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", "http://127.0.0.1:" + PORT], { env: childEnv() });
  } catch (e) { state.lastError = "无法启动 cloudflared: " + e.message; return { ok: false, err: state.lastError }; }
  const t = { type: "temp", proc, domain: null, startedAt: Date.now(), restarts: 0 };
  state.tunnel = t; state.lastError = "";
  pipeLog(proc, "temp");
  proc.on("error", e => { state.lastError = "cloudflared 运行失败: " + e.message; log(state.lastError); if (state.tunnel === t) state.tunnel = null; });
  proc.on("exit", c => {
    log("[temp] cloudflared 退出 code=" + c);
    if (state.tunnel === t) { if (!t.domain) state.lastError = "cloudflared 提前退出且未获得临时域名，详见日志"; state.tunnel = null; }
  });
  return { ok: true };
}
async function startFixed(p) {
  const token = String(p.token || "").trim();
  if (!token || token.length < 20) return { ok: false, err: "请填写有效的隧道 Token（CF Zero Trust 里复制的那串 eyJ 开头内容）" };
  let uuid = String(p.uuid || "").trim().toLowerCase();
  if (uuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid))
    return { ok: false, err: "UUID 格式不对（应为 8-4-4-4-12 的十六进制）" };
  if (uuid) state.uuids.add(uuid.replace(/-/g, ""));
  const f = { token, uuid: uuid || state.tempUUID,
    domain: String(p.domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    path: (String(p.path || "").trim().replace(/^\/+|\/+$/g, "") || PATH_DEF) };
  state.fixed = f;
  if (state.tunnel && state.tunnel.type === "temp") stopTunnel("切换固定隧道");
  if (state.tunnel) { state.fixed = f; return { ok: true, note: "已有固定隧道在运行，参数已更新（停止后再启动才生效）" }; }
  return spawnFixed();
}
function spawnFixed() {
  const f = state.fixed; if (!f) return { ok: false, err: "请先填写 Token" };
  if (!(ensureCfSync())) return { ok: true, note: "cloudflared 正在后台下载（约60MB），30秒后重新点一次启动" };
  let proc;
  try {
    proc = spawn(CF, ["tunnel", "--no-autoupdate", "--protocol", "http2", "run", "--token", f.token], { env: childEnv() });
  } catch (e) { state.lastError = "无法启动 cloudflared: " + e.message; return { ok: false, err: state.lastError }; }
  const t = { type: "fixed", proc, domain: f.domain || null, startedAt: Date.now(), restarts: 0 };
  state.tunnel = t; state.lastError = "";
  pipeLog(proc, "fixed");
  proc.on("error", e => { state.lastError = "cloudflared 运行失败: " + e.message; log(state.lastError); if (state.tunnel === t) state.tunnel = null; });
  proc.on("exit", c => {
    log("[fixed] cloudflared 退出 code=" + c);
    if (state.tunnel === t) state.tunnel = null;
    if (Date.now() - t.startedAt <= 30000) state.lastError = "固定隧道启动失败（Token 无效或参数错误），详见日志";
    // 意外退出且运行超过30秒 -> 自动重连(最多5次); 立即退出视为 token/配置错误不重试
    if (state.fixed === f && c !== 0 && Date.now() - t.startedAt > 30000 && t.restarts < 5) {
      t.restarts++; log("[fixed] 5秒后自动重连 (第" + t.restarts + "/5次)");
      setTimeout(() => { if (state.fixed === f && !state.tunnel) { const r = spawnFixed(); if (!r.ok) log("[fixed] 重连失败: " + r.err); } }, 5000);
    }
  });
  return { ok: true };
}
function ensureCfSync() { if (fs.existsSync(CF)) return true; ensureCf().then(ok => { if (ok && state.fixed && !state.tunnel) spawnFixed(); }); return false; }

/* ---------------- 链接生成 ---------------- */
function mkLink(uuid, host, path, name) {
  const pp = "/" + String(path).replace(/^\/+|\/+$/g, "");
  const q = new URLSearchParams({ encryption: "none", security: "tls", sni: host, fp: "chrome", type: "ws", host: host, path: pp });
  return "vless://" + uuid + "@" + host + ":443?" + q.toString() + "#" + encodeURIComponent(name);
}
function currentLinks() {
  const out = [];
  const t = state.tunnel;
  if (t && t.type === "temp" && t.domain)
    out.push(mkLink(state.tempUUID, t.domain, PATH_DEF, "CF-temp-" + t.domain.split(".")[0]));
  if (t && t.type === "fixed" && state.fixed && state.fixed.domain)
    out.push(mkLink(state.fixed.uuid, state.fixed.domain, state.fixed.path, "CF-" + state.fixed.domain.split(".")[0]));
  return out;
}

/* ---------------- 页面 ---------------- */
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CF 隧道节点生成器</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font:15px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#0b0f17;color:#dce3f0;max-width:880px;margin:0 auto;padding:22px 16px 60px}
h1{font-size:21px;margin:6px 0 2px}
.tip{color:#7e8ba6;font-size:12.5px;margin-bottom:16px}
.card{background:#121927;border:1px solid #22304a;border-radius:12px;padding:15px 16px;margin-bottom:14px}
.card h2{font-size:14px;color:#8fb7ff;margin:0 0 10px;font-weight:600}
.card h2 .st{float:right;font-weight:400;font-size:12px;color:#7e8ba6}
label{display:block;font-size:12.5px;color:#8b97ae;margin:9px 0 4px}
textarea,input[type=text]{width:100%;background:#0d1420;color:#e8eef9;border:1px solid #263450;border-radius:8px;padding:8px 10px;font:13.5px/1.5 ui-monospace,Consolas,monospace;outline:none}
textarea:focus,input[type=text]:focus{border-color:#3f6fd8}
.btn{background:#2563eb;border:none;color:#fff;border-radius:8px;padding:9px 18px;font-size:14px;cursor:pointer;font-weight:600}
.btn:hover{background:#1d4fd8}
.btn.warn{background:#b91c1c}
.ghost{background:transparent;border:1px solid #33456b;color:#aebcd8}
.mini{background:#1d3a75;border:none;color:#fff;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;white-space:nowrap}
.row{display:flex;gap:8px;align-items:center;background:#0d1420;border:1px solid #22304a;border-radius:8px;padding:7px 9px;margin-bottom:7px}
.row code{flex:1;font-size:11.5px;word-break:break-all;color:#9fe0b0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
@media(max-width:640px){.grid{grid-template-columns:1fr}}
.steps{font-size:12.5px;color:#9fb0cc;background:#0d1420;border:1px dashed #263450;border-radius:8px;padding:9px 12px;margin:8px 0;line-height:1.8}
.steps b{color:#cfe0ff}
.log{background:#080c14;border:1px solid #1c2740;border-radius:8px;padding:8px 10px;font:11px/1.6 ui-monospace,Consolas,monospace;color:#6f9a6f;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}
.err{color:#f87171;font-size:12.5px;margin-top:8px;white-space:pre-wrap}
.ok{color:#34d399;font-weight:600}
.dim{color:#7e8ba6;font-size:12px}
.mt{margin-top:10px}
.hide{display:none}
</style></head><body>
<h1>CF 隧道节点生成器</h1>
<div class="tip">本机既是生成器也是节点后端（VLESS over WS · 纯TCP） · 临时隧道零参数开箱即用 · 固定隧道填 Token 绑你自己的域名</div>

<div class="card"><h2>当前状态 <span class="st" id="st">加载中…</span></h2>
<div id="stat" class="dim">…</div></div>

<div class="card"><h2>模式一 · 临时隧道（什么都不填）</h2>
<div class="steps">点一下就启动：自动创建 <b>trycloudflare.com</b> 临时隧道（免登录、免域名、免配置），生成 VLESS-TLS-WS 节点。域名随机，<b>停止或实例重启后失效</b>，重按一次即换新域名。</div>
<button class="btn" id="bTemp" onclick="startTemp()">启动临时隧道并生成节点</button>
<div id="tempOut" class="hide mt"></div></div>

<div class="card"><h2>模式二 · 固定隧道（固定域名 + Token）</h2>
<div class="steps"><b>准备工作（CF 控制台一次性）：</b>① Zero Trust → Networks → Tunnels → <b>Create a tunnel</b> → 选 Cloudflared → 起个名字 → 复制那串 <b>Token</b>（eyJ 开头）；② 在该隧道 <b>Public Hostname</b> 里 Add：填你的子域名/域名，<b>Service</b> 填 <code>http://localhost:8080</code>；③ 把 Token 和域名填到下面启动。域名不变、长期可用，实例重启后点一次即恢复。</div>
<label>隧道 Token（必填，CF Zero Trust 复制）</label>
<textarea id="token" rows="3" placeholder="eyJhbGciOiJIUzI1NiIsImtpZCI6Ij..."></textarea>
<div class="grid">
<div><label>固定域名（你在 Public Hostname 绑定的）</label><input type="text" id="domain" placeholder="node.example.com"></div>
<div><label>UUID（留空 = 用自动生成的）</label><input type="text" id="uuid" placeholder="自动"></div>
</div>
<div class="grid">
<div><label>WS 路径（默认 vless）</label><input type="text" id="path" placeholder="vless"></div>
<div style="align-self:end"><button class="btn" id="bFix" onclick="startFixed()">启动固定隧道</button></div>
</div>
<div id="fixOut" class="hide mt"></div></div>

<div class="card"><h2>控制 <span class="st"><button class="mini" style="background:#7f1d1d" onclick="stopAll()">停止隧道</button></span></h2>
<div class="log" id="log">…</div>
<div id="err" class="err"></div></div>

<div class="tip" style="margin-top:4px">客户端：v2rayNG / NekoBox / Shadowrocket / Clash.Meta 等，从剪贴板导入或添加订阅链接均可。仅供学习研究网络技术使用。</div>

<script>
var $=function(id){return document.getElementById(id)};
function cp(t,btn){var ok=function(){if(btn){var o=btn.textContent;btn.textContent='已复制 ✓';setTimeout(function(){btn.textContent=o},1200)}};
 if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){fb(t,ok)})}else{fb(t,ok)}}
function fb(t,ok){var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.append(ta);ta.select();try{document.execCommand('copy')}catch(e){}ta.remove();ok()}
function linkBox(links,subLink){
 var h='';
 links.forEach(function(l){h+='<div class="row"><code>'+l.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</code><button class="mini" onclick="cp(this.previousSibling.textContent,this)">复制</button></div>'});
 if(links.length){h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">';
  h+='<button class="mini" onclick="cpSub()">复制订阅内容(base64)</button>';
  h+='<button class="mini" onclick="cp(location.origin+\\'/sub\\',this)">复制订阅链接</button></div>';
  h+='<div class="dim mt">订阅链接: <code>'+location.origin+'/sub</code></div>';}
 return h}
function cpSub(){fetch('/sub').then(function(r){return r.text()}).then(function(t){if(t==='NO_NODE'){alert('当前没有可用节点');return}cp(t)})}
function render(s){
 $('st').textContent = s.running ? (s.type==='temp'?'临时隧道运行中':'固定隧道运行中') : '未启动隧道';
 var up=[]; if(s.uptime) up.push('已运行 '+Math.floor(s.uptime/60)+' 分钟');
 up.push('cloudflared: '+(s.cf?'已就绪':'未下载'));
 up.push('UUID: <code>'+s.uuid+'</code>');
 up.push('路径: /'+s.path);
 $('stat').innerHTML=up.join(' &nbsp;·&nbsp; ');
 $('log').textContent=s.log.join('\\n');
 $('err').textContent=s.lastError||'';
 var lo=$('tempOut');
 if(s.type==='temp'&&s.domain&&s.links&&s.links.length){lo.classList.remove('hide');lo.innerHTML='<div class="ok">临时隧道已就绪: '+s.domain+'</div>'+linkBox(s.links)}
 else if(s.type==='temp'){lo.classList.remove('hide');lo.innerHTML='<div class="dim">隧道启动中，正在获取临时域名（约5-15秒）…</div>'}
 var lf=$('fixOut');
 if(s.type==='fixed'&&s.links&&s.links.length){lf.classList.remove('hide');lf.innerHTML='<div class="ok">固定隧道已连接'+(s.fixedDomain?' ('+s.fixedDomain+')':'')+'</div>'+linkBox(s.links)}
 else if(s.type==='fixed'){lf.classList.remove('hide');lf.innerHTML='<div class="dim">连接中…若1分钟后仍无节点，请检查 Token 与 Public Hostname 的 Service 是否为 http://localhost:8080</div>'}
 if(s.type!=='temp')lo.classList.add('hide');
 if(s.type!=='fixed')lf.classList.add('hide');
}
function post(url,body,btn){btn&&(btn.disabled=true);fetch(url,{method:'POST',body:body?JSON.stringify(body):undefined,headers:{'Content-Type':'application/json'}})
 .then(function(r){return r.json()}).then(function(j){if(j&&!j.ok&&j.err)alert(j.err);refresh();btn&&(btn.disabled=false)})
 .catch(function(e){alert('请求失败: '+e.message);btn&&(btn.disabled=false)})}
function startTemp(){post('/api/temp',null,$('bTemp'))}
function startFixed(){post('/api/fixed',{token:$('token').value,domain:$('domain').value,uuid:$('uuid').value,path:$('path').value},$('bFix'))}
function stopAll(){post('/api/stop',null,null)}
function refresh(){fetch('/api/status').then(function(r){return r.json()}).then(render).catch(function(){})}
refresh();setInterval(refresh,3000);
</script>
</body></html>`;

/* ---------------- HTTP 路由 ---------------- */
const server = http.createServer((req, res) => {
  let path = "/"; try { path = new URL(req.url, "http://x").pathname; } catch (e) {}
  const send = (code, body, ct) => { res.writeHead(code, { "Content-Type": ct || "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); };
  if (req.method === "GET" && (path === "/" || path === "/index.html")) return send(200, PAGE, "text/html; charset=utf-8");
  if (req.method === "GET" && path === "/api/status") {
    const t = state.tunnel;
    return send(200, JSON.stringify({
      ok: true, running: !!t, type: t ? t.type : null, domain: t ? t.domain : null,
      fixedDomain: state.fixed ? state.fixed.domain : null,
      uuid: state.tempUUID, path: PATH_DEF, cf: fs.existsSync(CF),
      lastError: state.lastError, log: state.log.slice(-14), uptime: Math.floor(process.uptime()),
      links: currentLinks(),
    }));
  }
  if (req.method === "POST" && path === "/api/temp") return startTemp().then(r => send(200, JSON.stringify(r)));
  if (req.method === "POST" && path === "/api/fixed") {
    let d = ""; req.on("data", c => d += c);
    return req.on("end", () => { let p = {}; try { p = JSON.parse(d || "{}"); } catch (e) {} startFixed(p).then(r => send(200, JSON.stringify(r))); });
  }
  if (req.method === "POST" && path === "/api/stop") { stopTunnel("手动"); return send(200, JSON.stringify({ ok: true })); }
  if (req.method === "GET" && path === "/sub") {
    const links = currentLinks();
    if (!links.length) return send(404, "NO_NODE", "text/plain; charset=utf-8");
    return send(200, Buffer.from(links.join("\n")).toString("base64"), "text/plain; charset=utf-8");
  }
  if (req.method === "GET" && path === "/healthz") return send(200, "ok", "text/plain");
  send(404, JSON.stringify({ ok: false, err: "not found" }));
});
server.on("upgrade", upgradeHandler);
server.listen(PORT, () => { globalThis.__CTS_UP = true; log("cf-tunnel-service v2 启动, 端口 " + PORT + ", 路径 /" + PATH_DEF + ", UUID " + state.tempUUID); });
process.on("uncaughtException", e => log("uncaught: " + e.message));
process.on("unhandledRejection", e => log("unhandled: " + (e && e.message || e)));
