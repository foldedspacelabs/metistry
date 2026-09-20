// The one end-to-end test: a CONFINED git pushes to a real HTTPS remote,
// through a CONNECT tunnel, authenticating with the askpass shim.
//
// Everything here is real. A self-signed TLS server running `git
// http-backend` over a real bare repository; Basic authentication, so
// `GIT_ASKPASS` is genuinely asked; a CONNECT proxy whose allowlist decision
// is core's own `egressAllows`; and `/usr/bin/sandbox-exec -f
// ops/sandbox/reconciler.sb` with the parameters `metistry up` computes.
// Afterwards the bare repository is asked what it received.
//
// Division of labour with the other two suites, so nothing is tested twice
// and nothing falls between them:
//
//   * `apps/watchdog/test/egress-proxy.unit.test.ts` drives the SHIPPED
//     proxy with raw sockets and owns every refusal (407, 403, non-loopback,
//     405, the audit row). This file's proxy is a socket pump over core's
//     allowlist — the policy is the shipped policy; the plumbing is local,
//     because `packages/` may not import `apps/` (the dependency arrow).
//   * `apps/reconciler/test/git-proxy.test.ts` owns the argv: that `git.ts`
//     emits `-c credential.helper=`, `GIT_ASKPASS` and the two variables
//     exactly when this install confines the reconciler.
//   * this file owns the thing neither can show on its own — that those
//     choices, together, put a commit on a remote from inside the sandbox.
//
// Darwin only, and skipped without a real git: `sandbox-exec` is a macOS
// binary and CI runs on Linux.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { egressAllows, parseConnectTarget } from "@foldedspacelabs/metistry-core";
import { askpassPath, askpassScript } from "../src/askpass.js";
import { globalGitConfigPath, reconcilerSandboxParams, reconcilerSandboxProfilePath, resolveGitBin, sandboxArgv, SANDBOX_EXEC } from "../src/sandbox.js";
import { startHttpsGitServer, type HttpsGitServer } from "./https-git-server.js";

const run = promisify(execFile);
const REPO = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const GIT = resolveGitBin({ productDir: REPO, path: process.env.PATH ?? "" });

const USER = "x-access-token";
const TOKEN = "tok-only-this-test-ever-sees";

/** The socket half of a CONNECT proxy; the allowlist decision is core's. */
function connectPump(allow: string[]): Promise<{ port: number; close: () => Promise<void>; refused: string[] }> {
  const refused: string[] = [];
  const server = net.createServer((client) => {
    client.once("data", (chunk) => {
      const line = chunk.toString("utf8").split("\r\n")[0] ?? "";
      const m = /^CONNECT\s+(\S+)/.exec(line);
      const target = parseConnectTarget(m?.[1]);
      if (!target || !egressAllows(allow, target)) {
        refused.push(m?.[1] ?? line);
        client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = net.connect({ host: target.host, port: target.port }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once("error", () => client.destroy());
      client.once("error", () => upstream.destroy());
    });
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () =>
      res({ port: (server.address() as net.AddressInfo).port, refused, close: () => new Promise<void>((r) => server.close(() => r())) }),
    );
  });
}

describe.skipIf(process.platform !== "darwin" || !existsSync(SANDBOX_EXEC) || !GIT || !existsSync("/usr/bin/openssl"))(
  "a confined reconciler pushes over HTTPS through the egress proxy (macOS)",
  () => {
    let root = "";
    let instance = "";
    let home = "";
    let server: HttpsGitServer;
    let proxy: Awaited<ReturnType<typeof connectPump>>;
    let proxyUrl = "";

    const confine = (argv: string[], extraEnv: NodeJS.ProcessEnv = {}) => {
      const params = reconcilerSandboxParams({
        productDir: join(root, "product"),
        nodeBin: process.execPath,
        instanceDir: instance,
        gitBin: GIT!,
        gitConfigGlobal: globalGitConfigPath(home),
        askpassBin: askpassPath(instance),
        reconcilerPort: 7812,
        consolePort: 8080,
        dbPort: 5432,
        embedPort: 11434,
        proxyPort: proxy.port,
        tmpDir: join(root, "tmp"),
      });
      const full = sandboxArgv(reconcilerSandboxProfilePath(REPO), params, argv);
      return run(full[0]!, full.slice(1), {
        timeout: 120_000,
        cwd: join(root, "product"),
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          LANG: "C",
          LC_ALL: "C",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          // the self-signed CA, inside the instance tree the profile grants
          GIT_SSL_CAINFO: join(instance, "ca.pem"),
          ...extraEnv,
        },
      });
    };

    /** The flags `apps/reconciler/src/git.ts` adds for a confined install — asserted there, mirrored here. */
    const confinedGit = (args: string[]) => [GIT!, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", `http.proxy=${proxyUrl}`, "-c", "credential.helper=", ...args];

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "metistry-push-"));
      instance = join(root, "instance");
      home = join(root, "home");
      await mkdir(join(root, "product"), { recursive: true });
      await mkdir(join(root, "tmp"), { recursive: true });
      await mkdir(join(root, "remotes"), { recursive: true });
      await mkdir(join(instance, "Journal"), { recursive: true });
      await mkdir(home, { recursive: true });

      // the owner's global config, with the credential helper `metistry
      // connect-repo` configures — the exact thing that cannot run confined
      await writeFile(globalGitConfigPath(home), "[user]\n\tname = Test\n\temail = t@example.test\n[credential]\n\thelper = osxkeychain\n");
      await mkdir(join(instance, ".metistry", "state", "bin"), { recursive: true });
      await writeFile(askpassPath(instance), askpassScript(process.execPath), { mode: 0o755 });

      await run(GIT!, ["init", "-q", "--bare", join(root, "remotes", "vault.git")]);
      server = await startHttpsGitServer({ projectRoot: join(root, "remotes"), gitBin: GIT!, certDir: join(root, "certs"), user: USER, token: TOKEN });
      await writeFile(join(instance, "ca.pem"), await import("node:fs/promises").then((fs) => fs.readFile(server.caFile, "utf8")));

      proxy = await connectPump([`127.0.0.1:${server.port}`]);
      proxyUrl = `http://reconciler:${"r".repeat(64)}@127.0.0.1:${proxy.port}`;

      await writeFile(join(instance, "Journal", "2026-09-19.md"), "a note the sole committer may write\n");
      const g = (args: string[]) => run(GIT!, ["-C", instance, ...args], { env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
      await g(["init", "-q", "-b", "main"]);
      await g(["add", "-A"]);
      await g(["commit", "-qm", "the vault, before the push"]);
      await g(["remote", "add", "origin", server.url("vault")]);
    }, 120_000);

    afterAll(async () => {
      await server?.close();
      await proxy?.close();
    });

    it("without the helper reset, the push dies on osxkeychain — the failure this whole path exists to fix", async () => {
      const argv = [GIT!, "-c", `http.proxy=${proxyUrl}`, "-C", instance, "push", "-q", "origin", "main:main"];
      await expect(confine(argv)).rejects.toThrow(/cannot exec 'git credential-osxkeychain get': Operation not permitted/);
    }, 120_000);

    it("with the reset and the askpass shim, a confined git pushes — and the bare repo has the commit", async () => {
      const before = await run(GIT!, ["-C", join(root, "remotes", "vault.git"), "log", "--oneline", "-1"]).catch(() => ({ stdout: "" }));
      expect(before.stdout.trim()).toBe(""); // nothing there yet

      await confine(confinedGit(["-C", instance, "push", "-q", "origin", "main:main"]), {
        GIT_ASKPASS: askpassPath(instance),
        METISTRY_GIT_ASKPASS_USER: USER,
        METISTRY_GIT_ASKPASS_TOKEN: TOKEN,
      });

      const after = await run(GIT!, ["-C", join(root, "remotes", "vault.git"), "log", "--oneline", "-1"]);
      expect(after.stdout.trim()).toContain("the vault, before the push");
      const files = await run(GIT!, ["-C", join(root, "remotes", "vault.git"), "show", "--format=", "--name-only", "HEAD"]);
      expect(files.stdout).toContain("Journal/2026-09-19.md");

      // the server saw Basic auth, and it was the credential the shim held
      expect(server.seen.at(-1)).toBe("Basic " + Buffer.from(`${USER}:${TOKEN}`).toString("base64"));
    }, 180_000);

    it("the credential is never in argv — it travels in the environment and nowhere else", async () => {
      // the argv the confined push actually runs, whole: the sandbox
      // parameters, git's flags, the refspec. `ps` shows this to every
      // process on the Mac, and a push runs every hour.
      const params = reconcilerSandboxParams({
        productDir: join(root, "product"),
        nodeBin: process.execPath,
        instanceDir: instance,
        gitBin: GIT!,
        gitConfigGlobal: globalGitConfigPath(home),
        askpassBin: askpassPath(instance),
        reconcilerPort: 7812,
        consolePort: 8080,
        dbPort: 5432,
        embedPort: 11434,
        proxyPort: proxy.port,
        tmpDir: join(root, "tmp"),
      });
      const argv = sandboxArgv(reconcilerSandboxProfilePath(REPO), params, confinedGit(["-C", instance, "push", "origin", "main:main"]));
      expect(argv.join(" ")).not.toContain(TOKEN);
      // …and the shim on disk holds no secret either: it names two variables
      const shim = await import("node:fs/promises").then((fs) => fs.readFile(askpassPath(instance), "utf8"));
      expect(shim).not.toContain(TOKEN);
      expect(shim).toContain("METISTRY_GIT_ASKPASS_TOKEN");
    });

    it("a remote the allowlist does not name is refused at the proxy, with the credential in hand", async () => {
      await run(GIT!, ["-C", instance, "remote", "add", "elsewhere", "https://127.0.0.1:1/other.git"], { env: { ...process.env, HOME: home } });
      await expect(
        confine(confinedGit(["-C", instance, "push", "-q", "elsewhere", "main:main"]), {
          GIT_ASKPASS: askpassPath(instance),
          METISTRY_GIT_ASKPASS_USER: USER,
          METISTRY_GIT_ASKPASS_TOKEN: TOKEN,
        }),
      ).rejects.toThrow(/CONNECT tunnel failed, response 403/);
      expect(proxy.refused).toContain("127.0.0.1:1");
    }, 120_000);

    it("with no proxy at all the profile refuses the connection itself — the door is the only way out", async () => {
      await expect(
        confine([GIT!, "-c", "credential.helper=", "-C", instance, "ls-remote", "origin"], {
          GIT_ASKPASS: askpassPath(instance),
          METISTRY_GIT_ASKPASS_USER: USER,
          METISTRY_GIT_ASKPASS_TOKEN: TOKEN,
        }),
      ).rejects.toThrow(/Couldn't connect to server|Failed to connect/);
    }, 120_000);
  },
);
