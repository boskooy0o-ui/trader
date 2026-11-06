const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const PORT = 8765;
const queue = [];
const waiters = [];
const pending = new Map();
let seen = 0;

const send = (res, code, body, type = "application/json") => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, { "Content-Type": type, "Content-Length": data.length });
  res.end(data);
};
const readBody = req => new Promise(r => {
  let s = "";
  req.on("data", c => (s += c));
  req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } });
});
const ollama = async (res, url, opts) => {
  try {
    const r = await fetch(OLLAMA + url, opts);
    send(res, 200, Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
};
const nextCmd = () => new Promise(resolve => {
  if (queue.length) return resolve(queue.shift());
  const w = { resolve };
  w.timer = setTimeout(() => {
    waiters.splice(waiters.indexOf(w), 1);
    resolve({});
  }, 8000);
  waiters.push(w);
});
const enqueue = cmd => {
  const w = waiters.shift();
  if (w) { clearTimeout(w.timer); w.resolve(cmd); } else queue.push(cmd);
};

http.createServer(async (req, res) => {
  const u = req.url;
  if (req.method === "GET") {
    if (u === "/" || u === "/index.html")
      return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html")), "text/html; charset=utf-8");
    if (u === "/api/tags") return ollama(res, "/api/tags");
    if (u === "/api/status") return send(res, 200, { plugin: Date.now() - seen < 20000 });
    if (u === "/plugin/poll") { seen = Date.now(); return send(res, 200, await nextCmd()); }
    return send(res, 404, {});
  }
  const b = await readBody(req);
  if (u === "/api/chat")
    return ollama(res, "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  if (u === "/api/cmd") {
    b.id = crypto.randomUUID().replace(/-/g, "");
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(b.id);
        resolve({ ok: false, output: "plugin timeout" });
      }, ((b.seconds || 0) + 40) * 1000);
      pending.set(b.id, r => { clearTimeout(timer); resolve(r); });
      enqueue(b);
    });
    return send(res, 200, result);
  }
  if (u === "/plugin/result") {
    const done = pending.get(b.id);
    if (done) { pending.delete(b.id); done(b); }
    return send(res, 200, {});
  }
  send(res, 404, {});
}).listen(PORT, "127.0.0.1", () => console.log(`Ollama Studio: http://localhost:${PORT}`));
