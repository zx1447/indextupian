/* cf-tunnel-service.js — 节点生成器 v2.1 (直连 + CF Worker 反代固定域名)
 * 运行于 Unikraft html-static-dal (official/node, LOADER 拉取本文件并 eval)
 * 说明: Unikraft 平台不支持 spawn 子进程(spawn ENOSYS), 无法运行 cloudflared。
 *       实例本身自带公网域名(443 TLS), 因此:
 *   模式1(零配置): 实例域名直连节点, 页面打开即生成, 长期可用
 *   模式2(固定域名): 在 Cloudflare 建 Worker 反代到实例域名, 生成你自己的域名节点
 */
"use strict";
const http = require("http"), net = require("net"), crypto = require("crypto");

const PORT = +(process.env.PORT || 8080);
const PATH_DEF = (process.env.VLESS_PATH || "vless").replace(/^\/+|\/+$/g, "");
const UUID_DEF = process.env.VLESS_UUID || crypto.randomUUID();

const state = {
  uuids: new Set([UUID_DEF.replace(/-/g, "")]),
  fixed: null,           // {domain, uuid, path} 固定域名节点(经 CF Worker 反代)
  log: [], lastError: "",
};

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

/* ---------------- 节点链接 ---------------- */
function mkLink(uuid, host, path, name) {
  const pp = "/" + String(path).replace(/^\/+|\/+$/g, "");
  const q = new URLSearchParams({ encryption: "none", security: "tls", sni: host, fp: "chrome", type: "ws", host: host, path: pp });
  return "vless://" + uuid + "@" + host + ":443?" + q.toString() + "#" + encodeURIComponent(name);
}

// host: 实例公网域名(取自请求 Host 头), 由各路由传入
function currentLinks(host) {
  if (!host) return [];
  const out = [mkLink(UUID_DEF, host, PATH_DEF, "dal-direct-" + host.split(".")[0])];
  if (state.fixed && state.fixed.domain)
    out.push(mkLink(state.fixed.uuid, state.fixed.domain, state.fixed.path, "cf-" + state.fixed.domain.split(".")[0]));
  return out;
}

/* ---------------- 固定域名管理 ---------------- */
function setFixed(p) {
  const domain = String(p.domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain))
    return { ok: false, err: "请填写有效的固定域名, 例如 node.example.com" };
  let uuid = String(p.uuid || "").trim().toLowerCase();
  if (uuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid))
    return { ok: false, err: "UUID 格式不对（应为 8-4-4-4-12 的十六进制）" };
  if (uuid) state.uuids.add(uuid.replace(/-/g, ""));
  const path = (String(p.path || "").trim().replace(/^\/+|\/+$/g, "") || PATH_DEF);
  state.fixed = { domain, uuid: uuid || UUID_DEF, path };
  log("固定域名节点已生成: " + domain + " (路径 /" + path + ")");
  return { ok: true, fixed: state.fixed };
}

/* ---------------- 页面 ---------------- */
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VPN 节点生成器</title>
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
<h1>VPN 节点生成器</h1>
<div class="tip">VLESS over WS · 实例自带 443 TLS · 模式一直连开箱即用 · 模式二绑你自己的域名</div>

<div class="card"><h2>当前状态 <span class="st" id="st">加载中…</span></h2>
<div id="stat" class="dim">…</div></div>

<div class="card"><h2>模式一 · 直连节点（零配置，打开即用）</h2>
<div class="steps">实例自带 <b>dal.unikraft.app</b> 公网域名和 TLS 证书，本身就是可用节点：<b>TLS + WS + VLESS</b>，长期有效、实例重启不变。下面链接已自动生成，直接复制导入客户端即可。</div>
<div id="directOut"></div></div>

<div class="card"><h2>模式二 · 固定域名节点（绑你自己的域名）</h2>
<div class="steps"><b>原理：</b>你的域名 → Cloudflare Worker（复制下方代码部署）→ 反代到实例域名。流量走你的固定域名，实例域名只作回源。<br>
<b>三步部署：</b>① 域名填到下面 → 生成节点链接和 Worker 代码；② Cloudflare 控制台 <b>Workers & Pages → Create Worker</b>，粘贴代码并 Deploy，再在 Worker 的 <b>Settings → Domains & Routes</b> 添加你的域名；③ 客户端导入生成的固定域名节点。</div>
<div class="grid">
<div><label>固定域名（已接入 CF 的域名）</label><input type="text" id="domain" placeholder="node.example.com"></div>
<div><label>UUID（留空 = 用自动生成的）</label><input type="text" id="uuid" placeholder="自动"></div>
</div>
<div class="grid">
<div><label>WS 路径（默认 vless）</label><input type="text" id="path" placeholder="vless"></div>
<div style="align-self:end"><button class="btn" id="bFix" onclick="genFixed()">生成固定域名节点</button></div>
</div>
<div id="fixOut" class="hide mt"></div></div>

<div class="card"><h2>运行日志 <span class="st"><button class="mini" style="background:#7f1d1d" onclick="clearFixed()">清除固定域名</button></span></h2>
<div class="log" id="log">…</div>
<div id="err" class="err"></div></div>

<div class="tip" style="margin-top:4px">客户端：v2rayNG / NekoBox / Shadowrocket / Clash.Meta 等，从剪贴板导入或添加订阅链接均可。仅供学习研究网络技术使用。</div>

<script>
var $=function(id){return document.getElementById(id)};
function cp(t,btn){var ok=function(){if(btn){var o=btn.textContent;btn.textContent='已复制 ✓';setTimeout(function(){btn.textContent=o},1200)}};
 if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,function(){fb(t,ok)})}else{fb(t,ok)}}
function fb(t,ok){var ta=document.createElement('textarea');ta.value=t;ta.style.position='fixed';ta.style.opacity='0';document.body.append(ta);ta.select();try{document.execCommand('copy')}catch(e){}ta.remove();ok()}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function linkBox(links,subLink){
 var h='';
 links.forEach(function(l){h+='<div class="row"><code>'+esc(l)+'</code><button class="mini" onclick="cp(this.previousSibling.textContent,this)">复制</button></div>'});
 if(links.length){h+='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">';
  h+='<button class="mini" onclick="cpSub()">复制订阅内容(base64)</button>';
  h+='<button class="mini" onclick="cp(location.origin+\\'/sub\\',this)">复制订阅链接</button></div>';
  h+='<div class="dim mt">订阅链接: <code>'+esc(location.origin)+'/sub</code></div>';}
 return h}
function cpSub(){fetch('/sub').then(function(r){return r.text()}).then(function(t){if(t==='NO_NODE'){alert('当前没有可用节点');return}cp(t)})}
var workerCode='';
function render(s){
 $('st').textContent = s.ok ? '运行中 · 已启动 '+Math.floor(s.uptime/60)+' 分钟' : '异常';
 var up=[]; up.push('UUID: <code>'+esc(s.uuid)+'</code>'); up.push('路径: /'+esc(s.path)); up.push('实例域名: <code>'+esc(s.host||'-')+'</code>');
 $('stat').innerHTML=up.join(' &nbsp;·&nbsp; ');
 $('log').textContent=s.log.join('\\n');
 $('err').textContent=s.lastError||'';
 var ld=$('directOut');
 if(s.links&&s.links.length){ld.innerHTML=linkBox([s.links[0]])}
 else{ld.innerHTML='<div class="dim">正在获取实例域名…</div>'}
 var lf=$('fixOut');
 if(s.fixedDomain){lf.classList.remove('hide');
  var fl=(s.links||[]).slice(1);
  lf.innerHTML='<div class="ok">固定域名节点已生成: '+esc(s.fixedDomain)+'</div>'+linkBox(fl)+
   '<div class="mt"><div class="dim" style="margin-bottom:5px">Worker 反代代码（部署到 Cloudflare Workers，域名绑定后生效）：</div>'+
   '<textarea rows="5" id="wcode" readonly>'+esc(workerCode)+'</textarea>'+
   '<button class="mini mt" onclick="cp(document.getElementById(\\'wcode\\').value,this)">复制 Worker 代码</button></div>';}
 else lf.classList.add('hide');
}
function post(url,body,btn){btn&&(btn.disabled=true);fetch(url,{method:'POST',body:body?JSON.stringify(body):undefined,headers:{'Content-Type':'application/json'}})
 .then(function(r){return r.json()}).then(function(j){if(j&&!j.ok&&j.err)alert(j.err);refresh();btn&&(btn.disabled=false)})
 .catch(function(e){alert('请求失败: '+e.message);btn&&(btn.disabled=false)})}
function genFixed(){workerCode='';post('/api/fixed',{domain:$('domain').value,uuid:$('uuid').value,path:$('path').value},$('bFix'))}
function clearFixed(){post('/api/stop',null,null)}
function refresh(){fetch('/api/status').then(function(r){return r.json()}).then(function(s){workerCode=s.workerCode||workerCode;render(s)}).catch(function(){})}
refresh();setInterval(refresh,3000);
</script>
</body></html>`;

/* ---------------- HTTP 路由 ---------------- */
const server = http.createServer((req, res) => {
  let path = "/"; try { path = new URL(req.url, "http://x").pathname; } catch (e) {}
  let host = String(req.headers.host || "").split(":")[0];
  const send = (code, body, ct) => { res.writeHead(code, { "Content-Type": ct || "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); };
  if (req.method === "GET" && (path === "/" || path === "/index.html")) return send(200, PAGE, "text/html; charset=utf-8");
  if (req.method === "GET" && path === "/api/status") {
    const links = currentLinks(host);
    const workerCode = state.fixed ? "export default {\n  async fetch(request) {\n    const url = new URL(request.url);\n    url.hostname = \"" + host + "\";\n    return fetch(new Request(url, request));\n  }\n}" : "";
    return send(200, JSON.stringify({
      ok: true, uuid: UUID_DEF, path: PATH_DEF, host: host,
      fixedDomain: state.fixed ? state.fixed.domain : null,
      workerCode: workerCode, links: links,
      lastError: state.lastError, log: state.log.slice(-14), uptime: Math.floor(process.uptime()),
    }));
  }
  if (req.method === "POST" && path === "/api/fixed") {
    let d = ""; req.on("data", c => d += c);
    return req.on("end", () => { let p = {}; try { p = JSON.parse(d || "{}"); } catch (e) {} send(200, JSON.stringify(setFixed(p))); });
  }
  if (req.method === "POST" && path === "/api/stop") { state.fixed = null; log("已清除固定域名设置"); return send(200, JSON.stringify({ ok: true })); }
  if (req.method === "GET" && path === "/sub") {
    const links = currentLinks(host);
    if (!links.length) return send(404, "NO_NODE", "text/plain; charset=utf-8");
    return send(200, Buffer.from(links.join("\n")).toString("base64"), "text/plain; charset=utf-8");
  }
  if (req.method === "GET" && path === "/healthz") return send(200, "ok", "text/plain");
  send(404, JSON.stringify({ ok: false, err: "not found" }));
});
server.on("upgrade", upgradeHandler);
server.listen(PORT, () => { globalThis.__CTS_UP = true; log("cf-tunnel-service v2.1 启动, 端口 " + PORT + ", 路径 /" + PATH_DEF + ", UUID " + UUID_DEF); });
process.on("uncaughtException", e => log("uncaught: " + e.message));
process.on("unhandledRejection", e => log("unhandled: " + (e && e.message || e)));
