import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const port = Number(process.env.PORT || 8770);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webm": "video/webm",
};

const compressed = new Set([".png", ".jpg", ".webm"]);

const send = (req, res, file) => {
  const body = fs.readFileSync(file);
  res.setHeader("content-type", types[path.extname(file)] || "application/octet-stream");
  if (compressed.has(path.extname(file))) {
    res.end(body);
    return;
  }
  res.setHeader("vary", "accept-encoding");
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.setHeader("content-encoding", "gzip");
    res.end(zlib.gzipSync(body));
    return;
  }
  res.end(body);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const rel = decodeURIComponent(url.pathname);
  if (rel === "/favicon.ico") {
    res.statusCode = 204;
    res.end();
    return;
  }
  const file = path.normalize(path.join(root, rel));
  const inside = file === root || file.startsWith(root + path.sep);
  if (inside && fs.existsSync(file) && fs.statSync(file).isFile()) {
    send(req, res, file);
    return;
  }
  if (/^\.[a-z]/i.test(path.extname(rel))) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  send(req, res, path.join(root, "index.html"));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}/projects`);
});
