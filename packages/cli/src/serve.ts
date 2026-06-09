/**
 * A tiny static file server for previewing output, plus helpers to find a free
 * port, detect the LAN IP, and open a browser. Zero dependencies.
 */

import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, normalize, extname, basename, dirname } from "node:path";
import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/** The first non-internal IPv4 address (a LAN address when on a network). */
export function lanIp(): string | undefined {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return undefined;
}

/** Probe ports starting at `start` until one binds; resolves to that port. */
export function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number, attempts: number) => {
      if (attempts <= 0) return reject(new Error("no free port found"));
      const srv = createServer();
      srv.once("error", () => tryPort(p + 1, attempts - 1));
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, "0.0.0.0");
    };
    tryPort(start, 50);
  });
}

export function openBrowser(url: string) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform === "win32" });
    child.unref();
  } catch {
    /* best effort */
  }
}

export interface ServeHandle {
  port: number;
  urls: string[];
  close: () => void;
}

/**
 * Serve a directory (or a single .html file) on 0.0.0.0:port. If `target` is a
 * file, it's served at `/`. Returns localhost + LAN URLs.
 */
export function serveStatic(target: string, port: number): ServeHandle {
  const isFile = existsSync(target) && statSync(target).isFile();
  const rootDir = isFile ? dirname(target) : target;
  const fileName = isFile ? basename(target) : null;

  const server = createServer((req, res) => {
    try {
      let urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
      if (urlPath === "/") urlPath = "/" + (fileName ?? "index.html");
      const full = normalize(join(rootDir, urlPath));
      if (!full.startsWith(normalize(rootDir))) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      const st = existsSync(full) ? statSync(full) : null;
      const file = st && st.isDirectory() ? join(full, "index.html") : full;
      const body = readFileSync(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("Not found");
    }
  });
  server.listen(port, "0.0.0.0");

  const urls = [`http://localhost:${port}/`];
  const ip = lanIp();
  if (ip) urls.push(`http://${ip}:${port}/`);

  return { port, urls, close: () => server.close() };
}
