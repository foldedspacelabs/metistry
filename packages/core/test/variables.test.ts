// Variables (design-build-plan §2.14, T4-4). Bold, the ticket's own: **a
// key-shaped value is refused** — at the parse, so a hand-edited file cannot
// carry one either, and with a message that never repeats the value. Beside
// it, the ways a variable could otherwise hold or leak a secret: a secret's
// name, a `{{ secret.x }}` smuggled in a value, a value equal to one of the
// instance's own secrets; and ruling 2 (K8): no schedule or time.
import { describe, expect, it } from "vitest";
import {
  InstanceSecrets,
  describeVariables,
  fillSecretRefs,
  fillVariableRefs,
  looksLikeKey,
  looksLikeSchedule,
  memoryKeychain,
  parseVariablesFile,
  readerOf,
  redactSecrets,
  secretHeldIn,
  variableNameIssue,
  variableRefsIn,
  variableValueIssue,
} from "../src/index.js";

/** Shapes of real credentials — built by concatenation so no scanner mistakes this file for a leak. */
const KEYS: Record<string, string> = {
  openai: "sk-" + "proj-" + "Ab3dEf6hIj9kLm2nOp5qRs8t",
  anthropic: "sk-" + "ant-api03-" + "x7Yq2Lm9Pz4Kd8Wn3Rt6Vb1Hc5Jf0",
  stripe: "sk_" + "live_" + "51HqAbCdEfGh12345678",
  github: "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0",
  github_pat: "github_" + "pat_" + "11ABCDEFG0123456789_abcdefghij",
  gitlab: "gl" + "pat-" + "xY7zW3vU9tS1rQ5p",
  slack: "xo" + "xb-" + "1234567890-abcdefghij",
  aws: "AK" + "IA" + "IOSFODNN7EXAMPLE",
  google: "AI" + "za" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q",
  linear: "lin_" + "api_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
  devin: "ap" + "k_" + "user_ZGV2aW4tdGVzdC1rZXk",
  jwt: "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  pem: "-----BEGIN " + "OPENSSH PRIVATE KEY-----",
  bearer: "Bearer " + "abcdef0123456789",
  url_password: "https://owner:" + "hunter2hunter2@git.example.com/repo.git",
  url_token: "https://calendar.example.com/feed.ics?" + "token=Zq81mNa0pLx",
  hex: "3f9a1c0b7e2d4a6f8b1c3e5d7f9a0b2c4d6e8f01",
  base64: "q8ZtR2mXv9LpW4kN7sJ1hG5fD3aB6cE0yU",
  base36: "k8s7df9a0lqz3mx2vb6n4c1r5t",
  in_prose: "use " + "gh" + "p_" + "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0 for pushes",
};

const PLAIN = [
  "Platform",
  "foldedspacelabs/metistry, foldedspacelabs/metistry-instance",
  "https://github.com/foldedspacelabs/metistry",
  "platform-team-infrastructure-2026",
  "MyCompanyEngineering2026",
  "ENG",
  "3f2a8c1e-9b4d-4e6f-8a1c-2b3d4e5f6a7b", // a UUID is an identifier
  "Acme Corporation, Inc.",
  "2026-10-01", // a date is a fact, not a timing
  "/Users/owner/Development/metistry-instance",
];

describe("**a key-shaped value is refused**", () => {
  it.each(Object.entries(KEYS))("%s", (_label, value) => {
    expect(looksLikeKey(value)).toBe(true);
    const issue = variableValueIssue("team_name", value);
    expect(issue?.code).toBe("key_shaped");
    expect(issue?.message).toContain("Store as Secret");
    expect(issue?.message).toContain("metistry secrets set team_name");
    // the refusal names the variable, never the value
    expect(issue?.message).not.toContain(value);
  });

  it("and at the parse: a hand-edited variables.yaml carrying one does not load, and the error does not echo it", () => {
    const text = `variables:\n  team_name: Platform\n  deploy: "${KEYS.github}"\n`;
    let message = "";
    try {
      parseVariablesFile(text);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/variables\.yaml does not validate — deploy: .*Store as Secret/);
    expect(message).not.toContain(KEYS.github);
  });

  it("a YAML error reports its code and line, not the source around it", () => {
    let message = "";
    try {
      parseVariablesFile(`variables:\n  a: "${KEYS.openai}\n  b: [\n`);
    } catch (e) {
      message = String(e);
    }
    expect(message).toMatch(/not valid YAML/);
    expect(message).not.toContain(KEYS.openai);
  });

  it("plain shared values are not", () => {
    for (const v of PLAIN) {
      expect(looksLikeKey(v), v).toBe(false);
      expect(variableValueIssue("team_name", v), v).toBeUndefined();
    }
  });
});

describe("a variable cannot hold or leak a secret", () => {
  it("a secret's name is refused — redact.ts would blank its value, and the name says what it is", () => {
    for (const n of ["api_key", "github_token", "db_password", "client_secret", "session_cookie"]) {
      expect(variableNameIssue(n)?.code, n).toBe("secret_name");
      // the reason: this is what every redacting path would do to it
      expect(redactSecrets({ [n]: "x" })[n]).not.toBe("x");
    }
    for (const n of ["ssh_key", "private_key", "github_pat", "bank_pin"]) expect(variableNameIssue(n)?.code, n).toBe("secret_name");
    // a bare `key` is an identifier (a Linear team key), not a credential
    expect(variableNameIssue("linear_team_key")).toBeUndefined();
  });

  it("a value cannot template: {{ secret.x }} in a value is refused, so filling a variable never introduces a secret reference", async () => {
    const issue = variableValueIssue("header", "{{ secret.github_write }}");
    expect(issue?.code).toBe("template");
    expect(() => parseVariablesFile(`variables:\n  header: "{{ secret.github_write }}"\n`)).toThrow(/cannot template/);

    // a hand-built file that skipped the parse is still refused at the fill
    const hand = { variables: { header: "{{ secret.github_write }}" } };
    const r = fillVariableRefs("Authorization: {{ variable.header }}", hand);
    expect(r.ok).toBe(false);

    // and end to end: variables, then the egress fill, sends only what the TEMPLATE referenced
    const kc = memoryKeychain();
    const secrets = new InstanceSecrets(kc, "11111111-2222-4333-8444-555555555555");
    await secrets.set("github_write", "SENTINEL-secret-value");
    const vars = parseVariablesFile(`variables:\n  org: foldedspacelabs\n`);
    const filled = fillVariableRefs("org={{ variable.org }}", vars);
    expect(filled).toEqual({ ok: true, text: "org=foldedspacelabs", used: ["org"] });
    const out = await fillSecretRefs(filled.ok ? filled.text : "", secrets);
    expect(out.ok && out.text).toBe("org=foldedspacelabs");
  });

  it("secretHeldIn names the secret a value equals or contains — a NAME, never the value", async () => {
    const kc = memoryKeychain();
    const secrets = new InstanceSecrets(kc, "11111111-2222-4333-8444-555555555555");
    await secrets.set("door_code", "4711");
    await secrets.set("wifi", "correct horse battery staple");
    expect(await secretHeldIn("4711", ["door_code", "wifi"], secrets)).toBe("door_code");
    expect(await secretHeldIn("the wifi is correct horse battery staple", ["door_code", "wifi"], secrets)).toBe("wifi");
    // short secrets match whole values only: a year is not a PIN
    expect(await secretHeldIn("since 4711 BC", ["door_code"], secrets)).toBeUndefined();
    expect(await secretHeldIn("Platform", ["door_code", "wifi", "missing"], secrets)).toBeUndefined();
  });
});

describe("no schedule or time lives in a variable (ruling 2, K8)", () => {
  it("by name", () => {
    for (const n of ["standup_time", "timezone", "tz", "working_days", "brief_schedule", "sync_cron", "standup_day", "work_hours", "review_cadence", "poll_interval"]) {
      const issue = variableNameIssue(n);
      expect(issue?.code, n).toBe("schedule_name");
      expect(issue?.message).toContain("Me/profile.md");
    }
    for (const n of ["team_name", "work_repos", "devin_org", "company", "today_cap"]) expect(variableNameIssue(n), n).toBeUndefined();
  });

  it("by value", () => {
    for (const v of ["09:15", "9:15 am", "9am", "09:00-17:30", "0 8 * * 1-5", "*/15 * * * *", "@daily", "America/New_York", "UTC", "mon, tue, wed", "Monday", "weekdays"]) {
      expect(looksLikeSchedule(v), v).toBe(true);
      expect(variableValueIssue("team_name", v)?.code, v).toBe("schedule_value");
    }
    for (const v of PLAIN) expect(looksLikeSchedule(v), v).toBe(false);
  });
});

describe("variables.yaml", () => {
  it("empty text and an empty mapping are no variables", () => {
    expect(parseVariablesFile("")).toEqual({ variables: {} });
    expect(parseVariablesFile("# nothing yet\nvariables:\n")).toEqual({ variables: {} });
  });

  it("keeps the file's names and values, and refuses what is not text, not one line, or not a name", () => {
    expect(parseVariablesFile(`variables:\n  team_name: Platform\n  devin_org: "org-8812"\n`).variables).toEqual({ team_name: "Platform", devin_org: "org-8812" });
    expect(() => parseVariablesFile(`variables:\n  count: 3\n`)).toThrow(/count: a variable's value is text/);
    expect(() => parseVariablesFile(`variables:\n  Team: x\n`)).toThrow(/not a variable name/);
    expect(() => parseVariablesFile(`variables:\n  a: "one\\ntwo"\n`)).toThrow(/one line/);
    expect(() => parseVariablesFile(`variables:\n  a: ""\n`)).toThrow(/cannot be empty/);
    expect(() => parseVariablesFile(`other: 1\n`)).toThrow(/only `variables:` belongs here/);
    expect(() => parseVariablesFile(`variables:\n  a: "${"x".repeat(1025)}"\n`)).toThrow(/at most 1024/);
  });
});

describe("{{ variable.name }}", () => {
  const file = parseVariablesFile(`variables:\n  team_name: Platform\n  company: Acme\n`);

  it("fills every reference, one pass, leaving {{ secret.x }} for the egress fill", () => {
    const r = fillVariableRefs("{{ variable.team_name }} at {{variable.company}}, auth {{ secret.github_write }}, again {{ variable.team_name }}", file);
    expect(r).toEqual({ ok: true, text: "Platform at Acme, auth {{ secret.github_write }}, again Platform", used: ["team_name", "company"] });
  });

  it("all or nothing: a missing name or a malformed reference fills nothing", () => {
    const missing = fillVariableRefs("{{ variable.team_name }} {{ variable.nope }}", file);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.missing).toEqual(["nope"]);
      expect(missing.message).toContain("metistry variables set");
    }
    const bad = fillVariableRefs("{{ variable.Team }} {{ variables.team_name }}", file);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.malformed).toEqual(["{{ variable.Team }}", "{{ variables.team_name }}"]);
  });

  it("variableRefsIn lists names once, in order", () => {
    expect(variableRefsIn("{{ variable.b }} {{ variable.a }} {{ variable.b }}")).toEqual({ names: ["b", "a"], malformed: [] });
  });
});

describe("the listing", () => {
  it("rows by name, with who reads each one and where it is used", () => {
    const file = parseVariablesFile(`variables:\n  team_name: Platform\n  company: Acme\n`);
    const usage = new Map([
      ["team_name", [".metistry/connections/github.yaml", ".metistry/agents/example/researcher.md", ".metistry/routines/brief/manifest.yaml"]],
    ]);
    expect(describeVariables(file, usage)).toEqual([
      { name: "company", value: "Acme", read_by: [], used_in: [] },
      {
        name: "team_name",
        value: "Platform",
        read_by: ["agent:researcher", "connection:github"],
        used_in: [".metistry/agents/example/researcher.md", ".metistry/connections/github.yaml", ".metistry/routines/brief/manifest.yaml"],
      },
    ]);
    expect(readerOf("agents/x/y/z.md")).toBe("agent:z");
    expect(readerOf("compute.yaml")).toBeUndefined();
  });
});
