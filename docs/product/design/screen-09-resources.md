# Screen 9 — Resources

New, 2026-09-22. Top-level in the nav. **The connections Metistry holds, and
lends.**

## 1. Why this is a screen and not a setting

Metistry can reach servers a remote agent cannot — a work network, something
behind a VPN, something IP-allowlisted. So it holds the credential and
**mediates**: an agent asks Metistry, Metistry asks the server. The agent never
sees the token.

That makes a connection a **resource** in exactly the sense Knowledge already is:
one thing, defined once, lent to several agents, routines and projects on
different terms. **Defining it** belongs in one place; **granting it** belongs in
the permissions table of whatever is being granted. Those are two different
questions, and the last two rounds showed what happens when one screen tries to
answer both.

**The credential never moves.** That is the sentence the screen exists to make
true, and it is why a proxied row in a permissions table is not the same object as
a grant: revoking here cuts every agent off at once, revoking there cuts one.

## 2. The list

```
Resources                                          [+ Connect A Server]

    SERVER         KIND                  TOOLS      GRANTED TO
 ●  ⧉ Jira         MCP · work network    14 tools   collator · drey-dev · 1 routine
 ●  ⧉ Confluence   MCP · work network    6 tools    collator
 ●  ⧉ Linear       MCP · hosted          9 tools    Nobody yet
 ◐  ⧉ Sentry       MCP · hosted          4 tools    Token expired 2 days ago
```

**Granted To is the column that earns the screen.** It answers *who can reach my
work Jira*, which is otherwise a question you answer by opening every agent in
turn. *Nobody yet* is a real value and says so: a connected server that nothing
uses is a credential sitting there for no reason.

A server whose token has expired is `degraded`, not `failed` — the connection is
configured correctly and a fact about the world changed.

## 3. One connection

### 3.1 The connection

| | |
| --- | --- |
| Endpoint | the URL, verbatim |
| Credential | *Held by Metistry — never handed to an agent* |
| Reachable From | *This machine only — no agent can reach it directly* |
| Last Checked | a time, and how many tools were discovered |

Those middle two lines are the security model stated as facts on the object
rather than as reassurance in a paragraph.

### 3.2 Tools — per tool, not per server

**Lazy tool discovery** is in the bridge contract, so the tool list is *what the
server said it has, the last time it was asked* — a fact with a timestamp, not a
configuration. The screen shows it that way.

Each tool is granted or not, individually. **Nobody who clicks *grant Jira* means
*including `delete_issue`*,** and a server-level switch is the shape that produces
that mistake, so there isn't one.

A destructive tool is **marked, not withheld**: `CLAUDE.md`'s bridge contract
requires **preview-then-confirm on destructive tools**, so the owner grants it
knowing it will show its work before doing it. The mark reads *Previews first*,
which is what the contract actually guarantees.

### 3.3 Lent to

Every principal holding any tool on this server, and on what terms — including
routines, whose grant says *during the run only*. Each links back. This is the
same provenance vocabulary as everywhere else, read from the resource's side
instead of the agent's.

## 4. The bridge contract already wrote the rules

`CLAUDE.md` requires every bridge to do **lazy tool discovery**,
**preview-then-confirm on destructive tools**, and **secret redaction by
default**. A proxied MCP server conforming to that contract inherits the
behaviour this screen would otherwise have to invent — which is the argument for
treating a proxied server as **a bridge, not a new species**.

## 5. States

| State | Copy |
| --- | --- |
| empty | "No servers connected." + *Metistry can reach servers your agents cannot, and lend them* |
| granted to nobody | *Nobody yet* on the row — a credential held for no reason is worth surfacing |
| degraded | the token expired, or discovery failed. The connection is still configured; a fact about the world changed |
| failed | could not reach the server at all, with the error verbatim |
| absent | configured by environment but the variable is unset — the variable named, not spent |

## 6. Data sources

Everything on this screen is ahead of its wire.

| Element | Source |
| --- | --- |
| the server list | **nothing** (D9) |
| discovered tools, and when | **nothing** — the bridge contract's `check()` is the nearest thing that exists |
| which principals hold which tools | **nothing** (D11) |
| calls made through the proxy | **nothing** (D12) — though `runs` is the right table |

## 7. Requests for the developer

| # | Request |
| --- | --- |
| **D9** | a registry of proxied servers: endpoint, credential reference, discovered tools with a discovery timestamp |
| **D11** | a **per-tool** grant, held beside an agent's other permissions rather than in a second place, so the matrix renders it as one more row |
| **D12** | a proxy audit line. A call an agent makes through Metistry is Metistry acting with the owner's credential, which is exactly what `runs` exists to record |
| **D13** | whether a resource can be granted to a **project** or a team rather than an agent. The owner raised it; it is a scoping axis nothing currently drawn has |
