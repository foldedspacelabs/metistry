# Screen 9 — Resources, now Connections

> **Superseded by §10 (2026-09-25, C114, C115).** A resource is a connection
> offered to agents through Metistry. The pane is **Settings › Connections**.

New, 2026-09-22. **Settings ▸ Resources**, in Settings' own window — it was briefly a top-level row and
moved, because a connection is configured once and then read from the permissions
tables that grant it (C57). **The connections Metistry holds, and lends.**

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

Each tool carries **three states**, set here because this is where they are set:

| | |
| --- | --- |
| **On** | runs when an agent calls it — no preview, because you chose it |
| **Ask** | shows what it would do, then waits for you in Needs You — see §4 |
| **Off** | refused at the proxy, and not offered to the agent at all |

**Nobody who clicks *grant Jira* means *including `delete_issue`*,** and a
server-level switch is the shape that produces that mistake, so there isn't one.

In an agent's or a routine's permissions matrix the same three states are read off
absence and one glyph — listed is On, listed with the clock is Ask, absent is Off —
so the vocabulary is one thing seen from two sides.

**Preview-then-confirm is what *Ask* means** — not a second marker beside the
control, but the middle state of it. `CLAUDE.md`'s bridge contract supplies the
behaviour; the control supplies the choice.

**The owner's choice is the whole control** (ruled 2026-09-22). An earlier draft
marked destructive tools *Previews first* alongside the setting, which said two
things at once and quietly overrode a deliberate **On**. If you choose On, it is
on. What a tool does is carried by its description, which is where that belongs:
the table informs the choice rather than second-guessing it.

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

## 4. What "Ask" looks like, and the problem in it

**The channel exists.** An *Ask* call is a request in Needs You, answered with the
four answers every request takes, delivered by web push when the owner is away:
`NOTIFICATION_TITLE` already maps `alert` to "Needs You" and `web-push` is already
a dependency. **Not a dialogue** — a dialogue assumes someone is sitting there,
which is exactly the case that does not hold.

**A synchronous approval inside an unattended run is a contradiction.** Morning
Digest runs at 6:02 AM and wants to comment on PROJ-412; the owner is asleep.
Blocking leaves the routine half-done for three hours. Failing throws away the
whole run over a step that was never urgent.

**So the run finishes without it and says so.** The output carries *I would have
commented on PROJ-412 — that needs your approval*, and the request lands in Needs
You. Nothing blocks, nothing is half-applied, and the fact is reported rather than
silently dropped — the same discipline as `later` not blocking and a failed action
leaving its row pending.

Which means **Ask means two things by context**, and that is worth stating rather
than papering over:

| Granted to | *Ask* means |
| --- | --- |
| an agent Metis is delegating to, in a conversation | **pause** — the owner is there |
| an unattended routine | **defer** — report it and move on |

**A default, not a guardrail.** An earlier draft of this said a destructive tool
should not be grantable as **On** to an unattended routine at all. That was the
design overriding a deliberate choice. A tool that writes where other people can
see it **defaults** to Ask and the owner may set it to On — the same shape the wire
already uses for `dispatch`, which defaults to `propose` rather than being
forbidden. (C59)

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

## 10. v2 — Connections (2026-09-25)

Board: `Connections`. Rulings C114, C115.

### 10.1 The list

Columns: status · name with its type glyph · **Type** (*MCP · API*, *Feed · RSS*)
· **Used By** (agents, syncs, routines, Metis) · a shield when it is offered to
agents · chevron. A connection whose secret failed shows *Key expired* in the
failed ink before its users. *Nobody yet* stays a real value.

### 10.2 Types

| Type | Is | Example |
| --- | --- | --- |
| MCP server | a server that offers tools | GitHub's, Jira on the work network |
| Agent | somewhere Metistry sends work — A2A, ACP | Devin, a crew on this Mac |
| API | an HTTP service with a key | AWS Cost Explorer |
| Feed | RSS, Atom or a calendar feed | a changelog |
| Files | a folder, a file or a web page | a Drive folder |

A connection may speak more than one (Devin: MCP and API). **Add Connection**
starts with the type.

### 10.3 One connection

- **How Metistry reaches it** — each endpoint, the key as a reference
  (`Bearer {{ secret.devin_key }}`), settings as variables
  (`{{ variable.devin_org }}`). Typing `{{` in any field opens a picker of secrets
  and variables; a secret row says where it may be sent.
- **Offer to agents through Metistry** — one switch (C115). Off: Metis and syncs
  only.
- **Tools — by what they do** — *Reads · Changes things · Starts an agent*, each
  On · Ask · Off. Non-MCP types show the tools Metistry made for them.
- **Used by** — syncs, agents, routines, Metis, each a link.

### 10.4 The proxy

Agent → MCP → Metistry's proxy (is this agent allowed; fill in its granted
secrets; call the service; log it) → the connection's own protocol. The agent
never reaches the service or holds its key.

### 10.5 Configuring one — known or custom (C118)

**Add Connection → type → known service or custom.** Known services are a
searchable grid; custom is *By URL* or *By command*.

- **Known service** — its named fields only (Devin: MCP, API, Key,
  Organization), tagged *Known service*, and a closed **Extra headers and
  parameters**.
- **Custom** — configured by how it is reached:

| Reached by | Used for | Asks for |
| --- | --- | --- |
| HTTP | MCP · A2A · API · Feed · a web page | URL · query parameters · authentication · headers · timeout, certificates, network |
| Command | MCP · ACP | command · arguments · folder · environment · runs on this Mac or in a container |
| Path | Files | folder or file · include and skip patterns · watch for changes |

- **Authentication** is a shortcut (None · Bearer · Basic · API Key · OAuth) that
  writes the header; the header list shows everything else.
- Name/value rows: names are plain text; values take text, secrets and
  variables. Remove with ×; *Add Header*, *Add Parameter*, *Add Variable*.
- **What it sends** — the resolved request, secrets masked as `•••••• (name)`.
- **Guards** — a secret bound for a host outside its *Sent only to* list shows
  a warning on its row with *Allow <host>*, and the preview shows the header as
  *blocked*. A secret in a URL is flagged. In a command's environment a secret
  is *given to this command only; never written to disk*.
- **A2A** takes the agent card URL and shows what it found (name, skills,
  streaming). **ACP** is a command.
