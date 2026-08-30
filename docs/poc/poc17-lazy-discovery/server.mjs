#!/usr/bin/env node
// PoC-17 toy bridge — minimal MCP stdio server, zero deps (spike only; real
// bridges use the official SDK). 40 plausible tools across 8 domains.
// MODE=eager exposes all 40 directly; MODE=lazy exposes 3 meta-tools
// (tool_index, execute, batch) per plan §4.3. Every underlying tool
// invocation appends a JSON line to CALL_LOG so the driver can score
// correctness identically in both modes.

import { appendFileSync } from "node:fs";

const MODE = process.env.MODE === "lazy" ? "lazy" : "eager";
const CALL_LOG = process.env.CALL_LOG ?? "/tmp/poc17-calls.jsonl";

// ---------- the 40 tools ----------
const DOMAINS = {
  calendar: ["list_today", "list_week", "create_event", "delete_event", "find_free_slot"],
  messages: ["list_recent", "search", "send", "list_unread", "get_thread"],
  reminders: ["create", "list_open", "complete", "delete", "list_overdue"],
  weather: ["current", "forecast_week", "alerts", "history", "air_quality"],
  system: ["cpu_usage", "disk_free", "memory_usage", "uptime", "process_list"],
  files: ["search", "read_text", "list_dir", "recent_downloads", "trash_status"],
  contacts: ["search", "get_details", "list_favorites", "recent_interactions", "birthdays_soon"],
  music: ["now_playing", "play_playlist", "pause", "search_library", "queue_status"],
};

const CANNED = {
  calendar_list_today: { events: [{ title: "Standup", start: "09:30", location: "office" }, { title: "Park picnic", start: "12:30", location: "outdoors" }] },
  messages_list_recent: { messages: [{ from: "Alex", text: "lunch tomorrow?" }, { from: "Sam", text: "PR is merged" }, { from: "Riley", text: "call me back" }] },
  reminders_create: { created: true, id: "rem-42" },
  system_cpu_usage: { cpu_percent: 17.4, load_1m: 2.1 },
  weather_current: { temp_f: 61, condition: "rain showers", precip_chance: 80 },
};

const tools = [];
for (const [domain, actions] of Object.entries(DOMAINS)) {
  for (const action of actions) {
    const name = `${domain}_${action}`;
    tools.push({
      name,
      description: `${domain}: ${action.replaceAll("_", " ")}`,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "free-form argument, optional" } },
      },
    });
  }
}

function invoke(name, args) {
  if (!tools.some((t) => t.name === name)) return { error: `no such tool: ${name}` };
  appendFileSync(CALL_LOG, JSON.stringify({ mode: MODE, tool: name, args }) + "\n");
  return CANNED[name] ?? { ok: true, tool: name, note: "canned empty result" };
}

// ---------- meta-tools (lazy mode) ----------
const metaTools = [
  {
    name: "tool_index",
    description: "List every tool this bridge offers: name + one-line description. Call this first to discover capabilities.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "execute",
    description: "Execute one named tool from tool_index with its arguments.",
    inputSchema: {
      type: "object",
      properties: { tool: { type: "string" }, args: { type: "object" } },
      required: ["tool"],
    },
  },
  {
    name: "batch",
    description: "Execute several named tools from tool_index in one call. Returns results in order.",
    inputSchema: {
      type: "object",
      properties: {
        calls: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, args: { type: "object" } }, required: ["tool"] } },
      },
      required: ["calls"],
    },
  },
];

function callTool(name, args) {
  if (MODE === "eager") return invoke(name, args ?? {});
  switch (name) {
    case "tool_index":
      return { tools: tools.map((t) => ({ name: t.name, description: t.description })) };
    case "execute":
      return invoke(args.tool, args.args ?? {});
    case "batch":
      return { results: (args.calls ?? []).map((c) => invoke(c.tool, c.args ?? {})) };
    default:
      return { error: `no such tool: ${name}` };
  }
}

// ---------- minimal JSON-RPC over stdio ----------
const exposed = MODE === "lazy" ? metaTools : tools;

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      respond(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "toy", version: "0.0.1" },
      });
    } else if (msg.method === "tools/list") {
      respond(msg.id, { tools: exposed });
    } else if (msg.method === "tools/call") {
      const out = callTool(msg.params.name, msg.params.arguments ?? {});
      respond(msg.id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } else if (msg.id !== undefined) {
      respond(msg.id, {});
    }
  }
});
