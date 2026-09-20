// A throwaway HTTPS git remote, for the one test that has to be end to end.
//
// Proving "a confined reconciler can push" needs a real push: a real TLS
// handshake (so the CONNECT tunnel is exercised rather than simulated), real
// Basic authentication (so `GIT_ASKPASS` is actually asked), and a real bare
// repository whose refs can be read back afterwards. Nothing off this
// machine, and nothing that outlives the test: a self-signed certificate for
// `127.0.0.1` in a temp directory, and `git http-backend` — which lives
// inside the same `GIT_PREFIX` the profile already grants — behind forty
// lines of CGI.
//
// `openssl` is macOS's own (LibreSSL, `/usr/bin/openssl`); this module is
// only ever imported by a darwin-gated test.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import https from "node:https";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface HttpsGitServer {
  /** `https://127.0.0.1:<port>/<repo>.git` */
  url: (repo: string) => string;
  port: number;
  /** the CA a client must trust — `GIT_SSL_CAINFO` */
  caFile: string;
  close: () => Promise<void>;
  /** every Authorization header the server saw, so a test can prove the credential arrived (and how) */
  seen: string[];
}

/**
 * Self-signed, `subjectAltName=IP:127.0.0.1`, two days.
 *
 * An IP SAN rather than a host name so the test needs no DNS and no
 * `/etc/hosts` line — the proxy's allowlist takes `127.0.0.1:<port>`, git's
 * URL takes the same, and TLS verifies against the SAN.
 */
export async function selfSignedCert(dir: string): Promise<{ key: string; cert: string }> {
  await mkdir(dir, { recursive: true });
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  await run("/usr/bin/openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
    "-days", "2", "-nodes", "-subj", "/CN=metistry-test", "-addext", "subjectAltName=IP:127.0.0.1",
  ]);
  return { key, cert };
}

export interface StartOptions {
  /** where the bare repositories live (`GIT_PROJECT_ROOT`) */
  projectRoot: string;
  /** an absolute path to a real git; `git-http-backend` is resolved beside it */
  gitBin: string;
  certDir: string;
  /** the Basic credentials the server demands — the pair the askpass shim must supply */
  user: string;
  token: string;
}

export async function startHttpsGitServer(opts: StartOptions): Promise<HttpsGitServer> {
  const { key, cert } = await selfSignedCert(opts.certDir);
  const backend = opts.gitBin.replace(/\/bin\/git$/, "/libexec/git-core/git-http-backend");
  const want = "Basic " + Buffer.from(`${opts.user}:${opts.token}`).toString("base64");
  const seen: string[] = [];

  const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const auth = req.headers.authorization ?? "";
    if (auth !== "") seen.push(auth);
    if (auth !== want) {
      // the 401 is what makes git ask askpass at all
      res.writeHead(401, { "www-authenticate": 'Basic realm="metistry-test"', "content-length": "0" });
      res.end();
      return;
    }
    const u = new URL(req.url ?? "/", "https://127.0.0.1");
    const cgi = spawn(backend, [], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        GIT_PROJECT_ROOT: opts.projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: opts.user,
        REMOTE_ADDR: "127.0.0.1",
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on("data", (d: Buffer) => {
      if (sent) return void res.write(d);
      head = Buffer.concat([head, d]);
      const i = head.indexOf("\r\n\r\n");
      if (i === -1) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, i).toString("utf8").split("\r\n")) {
        const c = line.indexOf(":");
        if (c === -1) continue;
        const k = line.slice(0, c).trim().toLowerCase();
        const v = line.slice(c + 1).trim();
        if (k === "status") status = Number(v.split(" ")[0]);
        else headers[k] = v;
      }
      sent = true;
      res.writeHead(status, headers);
      res.write(head.subarray(i + 4));
    });
    cgi.stdout.on("end", () => res.end());
    cgi.on("error", () => res.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    caFile: cert,
    seen,
    url: (repo) => `https://127.0.0.1:${port}/${repo}.git`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
