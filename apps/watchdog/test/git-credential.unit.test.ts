// The supervisor's keychain read: what it asks for, what it hands over, and
// the three things it must never do.
//
// `security` is driven through an injected runner so these tests touch no
// keychain at all — the shapes they pin are the ones probed against a real
// login Keychain on 2026-09-19 and recorded in the fixtures below.

import { describe, expect, it } from "vitest";
import { accountFromKeychainAttributes, DEFAULT_GIT_ACCOUNT } from "@foldedspacelabs/metistry-core";
import { findGitCredential, injectGitCredentials, lookupGitCredential, SECURITY_BIN, type RunResult, type Runner } from "../src/git-credential.js";

/** Verbatim `security find-internet-password` STDOUT — the same with or without `-g` (whose password goes to stderr — see the test below). */
const ATTRS = `keychain: "/Users/x/Library/Keychains/login.keychain-db"
class: "inet"
attributes:
    0x00000007 <blob>="github.com"
    "acct"<blob>="octocat"
    "atyp"<blob>="dflt"
    "ptcl"<uint32>="htps"
    "srvr"<blob>="github.com"
`;

const TOKEN = "gho-not-a-real-token";

function runner(script: Array<Partial<RunResult>>): { run: Runner; calls: Array<{ bin: string; args: string[] }> } {
  const calls: Array<{ bin: string; args: string[] }> = [];
  let i = 0;
  return {
    calls,
    run: async (bin, args) => {
      calls.push({ bin, args });
      return { code: 0, stdout: "", stderr: "", ...(script[i++] ?? {}) };
    },
  };
}

describe("reading the credential connect-repo filed", () => {
  it("asks for the account and the value separately, by absolute path, with no value ever in argv", async () => {
    const { run, calls } = runner([{ stdout: ATTRS }, { stdout: TOKEN + "\n" }]);
    expect(await lookupGitCredential("github.com", run)).toEqual({ user: "octocat", token: TOKEN });
    expect(calls).toEqual([
      // attributes only: no -g, no -w — the item's data is not read, so its ACL is not consulted
      { bin: SECURITY_BIN, args: ["find-internet-password", "-s", "github.com", "-r", "htps"] },
      { bin: SECURITY_BIN, args: ["find-internet-password", "-s", "github.com", "-r", "htps", "-w"] },
    ]);
    // the whole point: nothing this process runs has a secret on its
    // command line, where `ps` would show it to every process on the Mac
    for (const c of calls) expect(c.args.join(" ")).not.toContain(TOKEN);
  });

  it("the ACCOUNT lookup cannot leak the token: `security -g` puts attributes on stdout and the password on stderr", async () => {
    // probed against a real login Keychain, 2026-09-19 — this is the fact
    // the two-call split is built on, so it is pinned rather than assumed
    expect(ATTRS).not.toContain("password:");
    expect(accountFromKeychainAttributes(ATTRS)).toBe("octocat");
    // and a run whose stderr carries the value never has it read
    const { run } = runner([{ stdout: ATTRS, stderr: `password: "${TOKEN}"` }, { stdout: TOKEN + "\n" }]);
    const got = await lookupGitCredential("github.com", run);
    expect(got?.user).toBe("octocat");
  });

  it("falls back to the account connect-repo itself falls back to, and shrugs at a miss", async () => {
    const noAcct = runner([{ stdout: 'class: "inet"\n' }, { stdout: TOKEN }]);
    expect((await lookupGitCredential("github.com", noAcct.run))?.user).toBe(DEFAULT_GIT_ACCOUNT);
    // 44 is `security`'s "item not found"
    expect(await lookupGitCredential("github.com", runner([{ code: 44 }]).run)).toBeUndefined();
    expect(await lookupGitCredential("github.com", runner([{ stdout: ATTRS }, { code: 44 }]).run)).toBeUndefined();
    // an item with an empty password is not a credential
    expect(await lookupGitCredential("github.com", runner([{ stdout: ATTRS }, { stdout: "\n" }]).run)).toBeUndefined();
  });

  it("tells an item whose access list refuses the read apart from no item at all", async () => {
    // 2026-09-29: git-credential-osxkeychain had created the item, trusting only
    // itself; the attributes answer, the data read is refused without a session
    expect(await findGitCredential("github.com", runner([{ code: 44 }]).run)).toEqual({ miss: "missing" });
    expect(await findGitCredential("github.com", runner([{ stdout: ATTRS }, { code: 51, stderr: "security: SecKeychainSearchCopyNext: User interaction is not allowed." }]).run)).toEqual({ miss: "refused" });
    expect(await findGitCredential("github.com", runner([{ stdout: ATTRS }, { stdout: "\n" }]).run)).toEqual({ miss: "empty" });
  });

  it("unescapes an account name security quoted", () => {
    expect(accountFromKeychainAttributes('    "acct"<blob>="a\\"b"\n')).toBe('a"b');
    expect(accountFromKeychainAttributes('    "acct"<blob>=<NULL>\n')).toBeUndefined();
    expect(accountFromKeychainAttributes('    "acct"<blob>=""\n')).toBeUndefined();
  });
});

describe("handing it to the child that asked", () => {
  const children = () => [
    { name: "reconciler", env: { HOME: "/h" } },
    { name: "assistant", env: { HOME: "/a" } },
  ];

  it("reaches exactly one child — an install's other children cannot read it", async () => {
    const kids = children();
    const { run } = runner([{ stdout: ATTRS }, { stdout: TOKEN }]);
    const notes = await injectGitCredentials(kids, [{ child: "reconciler", host: "github.com" }], { platform: "darwin", run });
    expect(kids[0]!.env).toEqual({ HOME: "/h", METISTRY_GIT_ASKPASS_USER: "octocat", METISTRY_GIT_ASKPASS_TOKEN: TOKEN });
    // the engine's environment is untouched: a child's env is its own, and
    // the supervisor hands each one only what it asked for
    expect(kids[1]!.env).toEqual({ HOME: "/a" });
    expect(notes.join("\n")).toContain("github.com: found");
    // …and the log line names the host, never the account and never the value
    expect(notes.join("\n")).not.toContain(TOKEN);
    expect(notes.join("\n")).not.toContain("octocat");
  });

  it("a miss is a note and a child that starts anyway", async () => {
    const kids = children();
    const notes = await injectGitCredentials(kids, [{ child: "reconciler", host: "github.com" }], { platform: "darwin", run: runner([{ code: 44 }]).run });
    expect(kids[0]!.env).toEqual({ HOME: "/h" });
    expect(notes.join("\n")).toMatch(/no login Keychain item/);
    expect(notes.join("\n")).toMatch(/metistry connect-repo/);
  });

  it("an item the supervisor may not read says exactly that, and how to re-create it", async () => {
    const kids = children();
    const run = runner([{ stdout: ATTRS }, { code: 51 }]).run;
    const notes = (await injectGitCredentials(kids, [{ child: "reconciler", host: "github.com" }], { platform: "darwin", run })).join("\n");
    expect(kids[0]!.env).toEqual({ HOME: "/h" });
    expect(notes).toContain("[credential] github.com: item exists but its access list refuses a background read — run `metistry connect-repo <url> --force` to re-create it");
    expect(notes).not.toMatch(/no login Keychain item/);
    // host and cause only — never the account
    expect(notes).not.toContain("octocat");
  });

  it("no lookups, no calls; a non-darwin host says so rather than shelling out to a `security` that is not there", async () => {
    const empty = runner([]);
    expect(await injectGitCredentials(children(), [], { platform: "darwin", run: empty.run })).toEqual([]);
    expect(empty.calls).toEqual([]);
    const linux = runner([]);
    const notes = await injectGitCredentials(children(), [{ child: "reconciler", host: "github.com" }], { platform: "linux", run: linux.run });
    expect(linux.calls).toEqual([]);
    expect(notes.join("\n")).toContain("skipped on linux");
  });

  it("a lookup for a child this config does not run is a note, not a crash", async () => {
    const notes = await injectGitCredentials(children(), [{ child: "nobody", host: "github.com" }], { platform: "darwin", run: runner([]).run });
    expect(notes.join("\n")).toContain("no child named nobody");
  });
});
