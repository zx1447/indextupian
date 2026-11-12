/**
 * Nezha agent host for AetherHost (node:18-alpine container).
 * - HTTP server on 3000 (traefik readiness probe on / and /health)
 * - nezha agent loader (inline; targets NZ_HOST / NZ_TLS / NZ_CLIENT_SECRET env
 *   or defaults to nezha.vip1715.dpdns.org:443)
 * - keepalive pings every 3 min
 */

var http = require("http");
var https = require("https");
var os = require("os");

console.log("[Host] nezha agent host starting, node " + process.version + " on " + os.platform() + "/" + os.arch());

// ---- Agent loader (inline) ----
try {
    require("./agent-loader.js");
    console.log("[AgentLoader] loader returned");
} catch (e) {
    console.log("[AgentLoader] error: " + (e && e.message ? e.message : e));
}

// ---- HTTP server for health probe (must listen on 3000) ----
var started = Date.now();
http.createServer(function (req, res) {
    if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "healthy", uptime: Math.floor((Date.now() - started) / 1000), ts: new Date().toISOString() }));
    } else {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("nezha agent host online\nuptime: " + Math.floor((Date.now() - started) / 1000) + "s\npanel: " + (process.env.NZ_HOST || "nezha.vip1715.dpdns.org:443") + "\n");
    }
}).listen(3000, function () {
    console.log("[HTTP] listening on 3000");
});

// ---- Keepalive heartbeat ----
var KA1 = process.env.KEEPALIVE_URL || "https://maike.fadehost.app";
var KA2 = "https://nezha.vip1715.dpdns.org/";
var KA_INTERVAL = parseInt(process.env.KEEPALIVE_INTERVAL, 10) || 3 * 60 * 1000;
function ping(u, tag) {
    try {
        var rq = https.get(u, { timeout: 20000 }, function (rs) {
            rs.resume();
            console.log("[KeepAlive] " + tag + " -> HTTP " + rs.statusCode);
        });
        rq.on("timeout", function () { rq.destroy(); console.log("[KeepAlive] " + tag + " timeout"); });
        rq.on("error", function (e) { console.log("[KeepAlive] " + tag + " error: " + (e && e.message ? e.message : e)); });
    } catch (e) {}
}
setTimeout(function () {
    ping(KA1, KA1.replace("https://", "").slice(0, 40));
    ping(KA2, "panel");
    setInterval(function () { ping(KA1, KA1.replace("https://", "").slice(0, 40)); ping(KA2, "panel"); }, KA_INTERVAL);
}, 30 * 1000);

// ---- Agent monitor ----
setInterval(function () {
    try {
        var fs = require("fs");
        var dir = "/tmp/.sysmon";
        var cfg = fs.existsSync(dir + "/config.yml");
        var top = fs.existsSync(dir + "/top");
        console.log("[AgentMon] config=" + (cfg ? "ok" : "none") + " bin=" + (top ? "ok" : "none"));
    } catch (e) {}
}, 60 * 1000);

process.on("SIGTERM", function () { console.log("[Host] SIGTERM, exiting"); setTimeout(function () { process.exit(0); }, 300); });
process.on("SIGINT", function () { process.exit(0); });
