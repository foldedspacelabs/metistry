# Screen 19 — Secrets and Variables

New, 2026-09-25. **Settings › Secrets** and **Settings › Variables**. Board:
`Secrets`. Rulings C116, C117.

## 1. Secrets

- Stored in the Keychain, **per instance**. No environment variables to manage,
  no This Mac versus This instance.
- A value is **never shown again** after save; **Replace** swaps it.
- Referenced anywhere a value is typed as `{{ secret.name }}`.
- List columns: name · **Used by** and **Sent only to** · last used (or *Expired*
  in the failed ink). *Metistry's own* (database, bridges, owner door) is a
  collapsed group, rotate-only.

### 1.1 One secret

| Section | Holds |
| --- | --- |
| Value | dots, **Replace**, when set, when the service says it expires |
| Sent only to | hosts, editable; Metistry refuses any other |
| Who may use it | each connection and agent, On · Ask · Off, with how it is used |

**Used, never read.** Metistry fills a secret in on the way out. A model never
sees a value, so a secret cannot go in instructions. An agent that runs on this
Mac gets a granted secret as an environment variable (`GITHUB_READ`); the
transcript shows the name.

### 1.2 When one fails

One **access** request in Needs You: *Devin's key expired*, the things it stopped
(connection, syncs, agents), a field to paste the new key, **Replace Key**.

## 2. Variables

- Plain shared values: `standup_time`, `work_repos`, `devin_org`, `company`,
  `timezone`. Columns: name · value · used in.
- Referenced as `{{ variable.name }}` anywhere, **including an agent's
  instructions**; *Preview as the agent sees it* resolves them.
- A value that looks like a key is caught at save: *This looks like a key.
  Variables can be read by agents.* — **Store as Secret** · Save as Variable.

## 3. Requests for the developer

1. Collapse `SECRET_SCOPES`' user scope into instance.
2. Replace manifests' `env:NAME` with `{{ secret.name }}` and `{{ variable.name }}`;
   a name is lower-case, chosen by the owner, and maps to its Keychain item.
3. Store per secret: allowed hosts, grants, last used, expiry where the service
   reports it.
4. The proxy substitutes at egress and redacts on the way back (`core/redact.ts`).
