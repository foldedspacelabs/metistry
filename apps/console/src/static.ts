// Static file serving for the PWA shell. Public by design (the login page
// must render unauthenticated); the API stays authed. Paths resolve inside
// the web root only.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export async function serveStatic(res: ServerResponse, root: string, urlPath: string): Promise<boolean> {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(root, rel));
  if (!full.startsWith(normalize(root) + sep) && full !== normalize(join(root, "index.html"))) return false;
  try {
    const s = await stat(full);
    if (!s.isFile()) return false;
    res.writeHead(200, {
      "content-type": MIME[extname(full)] ?? "application/octet-stream",
      "content-length": s.size,
      // the shell is tiny; skip cache headaches while the UI iterates
      "cache-control": "no-cache",
    });
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(full);
      stream.pipe(res);
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    return true;
  } catch {
    return false;
  }
}
