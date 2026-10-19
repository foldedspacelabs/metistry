// ops/claude/guard-path.mjs, ops/claude/guard-bash.mjs and ops/git-hooks/commit-msg
// run as the harness / git runs them: a child process fed fixture input, judged
// by exit status (2 = refuse for the Claude hooks, 1 for the git hook) and by
// what reached stderr. A throwaway git repo with a real linked worktree stands
// in for the checkout; nothing here touches the real repo or its hooks.
//
// Run: node --test ops/scripts/test/

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PATH_GUARD = fileURLToPath(new URL("../../claude/guard-path.mjs", import.meta.url));
const BASH_GUARD = fileURLToPath(new URL("../../claude/guard-bash.mjs", import.meta.url));
const COMMIT_MSG = fileURLToPath(new URL("../../git-hooks/commit-msg", import.meta.url));
const TRAILER = "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>";

// Scrub anything that would switch a guard off or point it elsewhere.
const cleanEnv = () => {
  const e = { ...process.env };
  for (const k of ["METISTRY_GUARD_ALLOW", "METISTRY_MAIN_CHECKOUT", "METISTRY_ALLOW_NO_TRAILER", "METISTRY_REQUIRE_TRAILER", "METISTRY_TRAILER", "CLAUDECODE"]) delete e[k];
  return e;
};

let root, main, wt, otherWt;
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...cleanEnv(), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

before(() => {
  // root/Metistry (main checkout) with linked worktrees root/metistry-t1 and root/notes-wt
  root = realpathSync(mkdtempSync(join(tmpdir(), "guards-")));
  main = join(root, "Metistry");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-q", "-m", "init");
  wt = join(root, "metistry-t1");
  otherWt = join(root, "notes-wt");
  git(main, "worktree", "add", "-q", "-b", "t1", wt);
  git(main, "worktree", "add", "-q", "-b", "t2", otherWt);
});
after(() => rmSync(root, { recursive: true, force: true }));

const run = (script, stdin, env = {}, cwd = root) =>
  spawnSync(process.execPath, [script], { input: typeof stdin === "string" ? stdin : JSON.stringify(stdin), encoding: "utf8", env: { ...cleanEnv(), ...env }, cwd });

const edit = (file_path, extra = {}) => ({ tool_name: "Edit", cwd: wt, tool_input: { file_path, old_string: "a", new_string: "b" }, ...extra });

// ---- guard-path -----------------------------------------------------------

test("path guard: a file inside the ticket worktree is allowed (existing and new, nested)", () => {
  for (const f of [join(wt, "a.txt"), join(wt, "new/dir/file.ts"), join(root, "metistry-md-9", "x.md")]) {
    const r = run(PATH_GUARD, edit(f));
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test("path guard: any path under the main checkout is refused (exit 2), whatever the tool", () => {
  for (const tool of [["Edit", "file_path"], ["Write", "file_path"], ["MultiEdit", "file_path"], ["NotebookEdit", "notebook_path"]]) {
    const r = run(PATH_GUARD, { tool_name: tool[0], cwd: wt, tool_input: { [tool[1]]: join(main, "a.txt") } });
    assert.equal(r.status, 2, tool[0]);
    assert.match(r.stderr, /main checkout/);
  }
  assert.equal(run(PATH_GUARD, edit(join(main, ".claude", "settings.json"))).status, 2);
  assert.equal(run(PATH_GUARD, edit(main.toUpperCase() === main ? main.toLowerCase() + "/a.txt" : main.toUpperCase() + "/a.txt")).status, 2, "case variant");
});

test("path guard: outside ../metistry-* is refused — home, /etc, another sibling, the parent directory itself", () => {
  for (const f of ["/etc/hosts", join(root, "notes-wt", "a.txt"), join(root, "loose.txt"), join(root, "metistry-loose.txt"), join(tmpdir(), "elsewhere.txt"), "/Users/nobody/.claude/settings.json"]) {
    const r = run(PATH_GUARD, edit(f));
    assert.equal(r.status, 2, f);
    assert.match(r.stderr, /outside every ticket worktree/, f);
  }
});

test("path guard: `..`, relative paths and symlinks cannot walk back into the main checkout", () => {
  assert.equal(run(PATH_GUARD, edit(join(wt, "..", "Metistry", "a.txt"))).status, 2, "dotdot");
  assert.equal(run(PATH_GUARD, { tool_name: "Write", cwd: wt, tool_input: { file_path: "../Metistry/a.txt" } }).status, 2, "relative to cwd");
  assert.equal(run(PATH_GUARD, { tool_name: "Write", cwd: wt, tool_input: { file_path: "inside.txt" } }).status, 0, "relative inside");
  symlinkSync(main, join(wt, "link-to-main"));
  assert.equal(run(PATH_GUARD, edit(join(wt, "link-to-main", "a.txt"))).status, 2, "symlink to main");
  assert.equal(run(PATH_GUARD, edit(join(wt, "link-to-main", "not-yet", "new.txt"))).status, 2, "symlink, file not yet created");
});

test("path guard: the session scratch directory is writable, a lookalike is not", () => {
  const uid = process.getuid();
  const scratch = realpathSync("/tmp") + `/claude-${uid}/-proj/session/scratchpad/md-1/pr-body.md`;
  assert.equal(run(PATH_GUARD, edit(scratch)).status, 0);
  assert.equal(run(PATH_GUARD, edit(realpathSync("/tmp") + `/claude-${uid}x/f`)).status, 2);
  assert.equal(run(PATH_GUARD, edit(realpathSync("/tmp") + `/claude-${uid + 1}/f`)).status, 2);
});

test("path guard: malformed or incomplete input is refused, a non-path tool is not its business", () => {
  for (const bad of ["", "not json", "null", "[]", '"x"']) assert.equal(run(PATH_GUARD, bad).status, 2, JSON.stringify(bad));
  assert.equal(run(PATH_GUARD, { tool_name: "Edit", cwd: wt, tool_input: {} }).status, 2);
  assert.equal(run(PATH_GUARD, { tool_name: "Write", cwd: wt, tool_input: { file_path: "" } }).status, 2);
  assert.equal(run(PATH_GUARD, { tool_name: "Read", cwd: main, tool_input: { file_path: join(main, "a.txt") } }).status, 0);
});

test("path guard: a subagent call (agent_id present) is held to the same rule", () => {
  assert.equal(run(PATH_GUARD, edit(join(main, "a.txt"), { agent_id: "agent-1", agent_type: "implement" })).status, 2);
});

test("path guard: owner bypass is the session environment, not anything in the input", () => {
  assert.equal(run(PATH_GUARD, edit(join(main, "a.txt")), { METISTRY_GUARD_ALLOW: "1" }).status, 0);
  assert.equal(run(PATH_GUARD, edit(join(main, "a.txt"), { env: { METISTRY_GUARD_ALLOW: "1" }, METISTRY_GUARD_ALLOW: "1" })).status, 2);
  assert.equal(run(PATH_GUARD, edit(join(main, "a.txt")), { METISTRY_GUARD_ALLOW: "0" }).status, 2);
});

// ---- guard-bash -----------------------------------------------------------

const bash = (command, env) => run(BASH_GUARD, { tool_name: "Bash", cwd: wt, tool_input: { command } }, env);
const refused = (command) => {
  const r = bash(command);
  assert.equal(r.status, 2, `should refuse: ${command}`);
  assert.match(r.stderr, /guard-bash: refused/);
};
const allowed = (command) => assert.equal(bash(command).status, 0, `should allow: ${command}`);

test("bash guard: `security` against the login Keychain is refused, in every position a command can sit", () => {
  for (const c of [
    "security find-generic-password -s foo",
    "security dump-keychain",
    "/usr/bin/security list-keychains",
    "cd x && security unlock-keychain",
    "echo hi; security find-identity",
    "foo | xargs security delete-generic-password",
    "sudo security add-trusted-cert x",
    "env FOO=1 security find-generic-password",
    "bash -c 'security find-generic-password -s x'",
    "echo $(security find-generic-password -ws x)",
    "echo `security dump-keychain`",
    "true\nsecurity find-identity",
    "security find-generic-password -s x ~/Library/Keychains/login.keychain-db",
  ]) refused(c);
});

test("bash guard: `security` aimed at an explicit non-login keychain, and the word elsewhere, are not refused", () => {
  allowed("security create-keychain -p x /tmp/scratch/test.keychain-db");
  allowed('git commit -m "tighten security checks"');
  allowed("grep -rn security docs/");
  allowed("pnpm audit # security");
  allowed("echo security");
});

test("bash guard: launchctl, caffeinate and pmset are refused", () => {
  for (const c of ["launchctl list", "launchctl bootout gui/501/x", "sudo pmset -a sleep 0", "caffeinate -i sleep 10", "x && /bin/launchctl load f", "nohup caffeinate &"]) refused(c);
  allowed("echo launchctl is forbidden");
  allowed("git log --grep=pmset");
});

test("bash guard: connection strings naming 5432, 8080 or 7810-7815 are refused", () => {
  for (const c of [
    "psql postgres://u@127.0.0.1:5432/db",
    "psql -h 127.0.0.1 -p 5432 -U x",
    "psql -p5432 x",
    "psql --port=5432",
    "PGPORT=5432 psql",
    "export METISTRY_DB_PORT=5432",
    "psql 'host=127.0.0.1 port=5432 dbname=x'",
    "curl http://127.0.0.1:8080/api/state",
    "curl localhost:8080",
    "curl -s http://[::1]:8080/",
    "curl http://127.0.0.1:7810/health",
    "nc 127.0.0.1 -p 7815",
    "docker run -p 8080:8080 x",
  ]) refused(c);
});

test("bash guard: other ports and look-alike numbers are not refused", () => {
  for (const c of [
    "psql postgres://u@127.0.0.1:55432/db",
    "psql -h 127.0.0.1 -p 55432",
    "curl http://127.0.0.1:18080/",
    "curl http://127.0.0.1:7809/ http://127.0.0.1:7816/",
    "PGPORT=45432 psql",
    "pg_ctl -o '-p 54329' start",
    "echo 5432",
    "date +%H:%M",
  ]) allowed(c);
});

test("bash guard: prose in a here-document is not a command, the line that opens it still is", () => {
  allowed("git commit -F - <<'EOF'\nfix: stop talking to 127.0.0.1:5432\n\nsecurity notes\nEOF");
  refused("git commit -F - <<'EOF'\nok\nEOF\nlaunchctl list");
  refused("psql 127.0.0.1:5432 <<'EOF'\nselect 1;\nEOF");
});

test("bash guard: malformed input is refused, other tools pass, the owner bypass is the environment", () => {
  for (const bad of ["", "nope", "null"]) assert.equal(run(BASH_GUARD, bad).status, 2, JSON.stringify(bad));
  assert.equal(run(BASH_GUARD, { tool_name: "Bash", tool_input: {} }).status, 2);
  assert.equal(run(BASH_GUARD, { tool_name: "Read", tool_input: { command: "launchctl list" } }).status, 0);
  assert.equal(bash("launchctl list", { METISTRY_GUARD_ALLOW: "1" }).status, 0);
  assert.equal(bash("METISTRY_GUARD_ALLOW=1 launchctl list").status, 2, "an inline assignment is not the environment");
});

// ---- commit-msg -----------------------------------------------------------

const commitMsg = (message, env = {}, cwd = wt) => {
  const f = join(root, `msg-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, message);
  return spawnSync("sh", [COMMIT_MSG, f], { encoding: "utf8", cwd, env: { ...cleanEnv(), ...env } });
};

test("commit-msg: in an agent session a message without the trailer is refused (exit 1) and says what to add", () => {
  for (const m of ["fix: a thing\n", "fix: a thing\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>\n", "# Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nfix\n", "fix\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com> extra\n"]) {
    const r = commitMsg(m, { CLAUDECODE: "1" });
    assert.equal(r.status, 1, m);
    assert.match(r.stderr, /Claude Fable 5\.1/);
  }
});

test("commit-msg: the trailer — any case of the key, CRLF, anywhere in the message — passes", () => {
  for (const m of [`fix\n\n${TRAILER}\n`, `fix\n\nco-authored-by: Claude Fable 5.1 <noreply@anthropic.com>\n`, `fix\r\n\r\n${TRAILER}\r\n`, `${TRAILER}\nfix\n`, `fix\n\n${TRAILER}`]) {
    assert.equal(commitMsg(m, { CLAUDECODE: "1" }).status, 0, JSON.stringify(m));
  }
});

test("commit-msg: outside an agent session it stays out of the way, unless the owner requires it everywhere", () => {
  assert.equal(commitMsg("fix: by hand\n").status, 0);
  assert.equal(commitMsg("fix: by hand\n", { CLAUDECODE: "0" }).status, 0);
  assert.equal(commitMsg("fix: by hand\n", { METISTRY_REQUIRE_TRAILER: "1" }).status, 1);
  assert.equal(commitMsg(`fix\n\n${TRAILER}\n`, { METISTRY_REQUIRE_TRAILER: "1" }).status, 0);
});

test("commit-msg: the owner bypass, a newer trailer, and a merge in progress", () => {
  assert.equal(commitMsg("fix\n", { CLAUDECODE: "1", METISTRY_ALLOW_NO_TRAILER: "1" }).status, 0);
  const next = "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>";
  assert.equal(commitMsg(`fix\n\n${next}\n`, { CLAUDECODE: "1", METISTRY_TRAILER: next }).status, 0);
  assert.equal(commitMsg(`fix\n\n${TRAILER}\n`, { CLAUDECODE: "1", METISTRY_TRAILER: next }).status, 1);
  writeFileSync(join(git(wt, "rev-parse", "--absolute-git-dir").trim(), "MERGE_HEAD"), git(wt, "rev-parse", "HEAD"));
  try {
    assert.equal(commitMsg("Merge branch 'x'\n", { CLAUDECODE: "1" }).status, 0);
  } finally {
    rmSync(join(git(wt, "rev-parse", "--absolute-git-dir").trim(), "MERGE_HEAD"));
  }
  assert.equal(commitMsg("fix\n", { CLAUDECODE: "1" }).status, 1, "MERGE_HEAD gone");
});

test("commit-msg: installed as a real hook it refuses `git commit` in an agent session and takes the trailer", () => {
  const hooks = join(git(wt, "rev-parse", "--git-common-dir").trim().replace(/^\.git$/, join(main, ".git")), "hooks");
  mkdirSync(hooks, { recursive: true });
  spawnSync("cp", [COMMIT_MSG, join(hooks, "commit-msg")]);
  writeFileSync(join(wt, "b.txt"), "b\n");
  git(wt, "add", "b.txt");
  const env = { ...cleanEnv(), CLAUDECODE: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const bad = spawnSync("git", ["commit", "-q", "-m", "no trailer"], { cwd: wt, encoding: "utf8", env });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /commit-msg: refused/);
  const good = spawnSync("git", ["commit", "-q", "-m", "with trailer", "-m", TRAILER], { cwd: wt, encoding: "utf8", env });
  assert.equal(good.status, 0, good.stderr);
});
