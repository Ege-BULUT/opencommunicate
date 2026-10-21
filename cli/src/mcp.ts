/* `opencom mcp`: the command line's chat as an MCP server (stdio, JSON-RPC 2.0, one message per line), so an
   agent harness that speaks MCP gets send, history, inbox, answer and the rest as tools. stdout carries only
   protocol messages; anything else goes to stderr. Waking a session when a message arrives is still
   `opencom watch --once --to-me` in the background: a tool call can only answer, never call the agent first. */
import fs from "node:fs";
import readline from "node:readline";
import { REACTIONS, REACTION_NAMES, STATUS_MAX, Watcher, addressedTo, answerFor, handle, newestByChannel, type Bus, type Device, type Group, type Message, type Reaction } from "../../core/src/index.ts";
import { notifyRecipients } from "../../core/src/notify.ts";

type Ctx = {
  bus: Bus; me: Device; repo: string; version: string; cursor: string; readReceipts: boolean;
  load: () => Promise<{ devices: Device[]; groups: Group[] }>;
  resolveTarget: (to: string, me: Device, devices: Device[], groups: Group[]) => string;
  label: (ch: string, me: Device, devices: Device[], groups: Group[]) => string;
  line: (m: Message, me: Device, devices: Device[], groups: Group[], quoted?: Map<string, Message>) => string;
  status: () => string; // the configured status, as it is now
  setStatus: (text: string) => void;
};

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const str = (description: string) => ({ type: "string", description });
const CHAT = str("all, nick#1234, 1234 or a group name");
const TOOLS = [
  { name: "send", description: "Send a message. With choices it is a question: the apps show a button per choice and one to write something else, and the answer comes back as a reply whose answer.choice is the index picked (null when written).",
    inputSchema: { type: "object", properties: { to: CHAT, text: str("the message"), reply: str("id of a message in that chat to quote"), choices: { type: "array", items: { type: "string" }, description: "1 to 10 one-line choices" } }, required: ["to", "text"] } },
  { name: "inbox", description: "New messages since the last inbox call (the first call starts from now), as lines that begin with each message's id. Marks them read. Only those addressed to you (DMs, replies to you, @mentions) unless all is true.",
    inputSchema: { type: "object", properties: { all: { type: "boolean", description: "every new message in your chats" } } } },
  { name: "history", description: "Recent messages of a chat, oldest first, each line beginning with its id.",
    inputSchema: { type: "object", properties: { chat: CHAT, n: { type: "number", description: "how many (default 20)" } }, required: ["chat"] } },
  { name: "answer", description: "Answer a question with choices: text that is one of its choices picks it, anything else is a written answer.",
    inputSchema: { type: "object", properties: { chat: CHAT, id: str("the question's message id"), text: str("a choice, or your own answer") }, required: ["chat", "id", "text"] } },
  { name: "react", description: `React to a message: ${Object.entries(REACTION_NAMES).map(([k, e]) => `${k} ${e}`).join(", ")}; off takes yours back.`,
    inputSchema: { type: "object", properties: { chat: CHAT, id: str("message id"), reaction: { type: "string", enum: [...Object.keys(REACTION_NAMES), "off"] } }, required: ["chat", "id", "reaction"] } },
  { name: "status", description: `Say what you are doing, one line of ${STATUS_MAX} characters at most; the apps show it next to "online" in your chat. An empty text clears it.`,
    inputSchema: { type: "object", properties: { text: str("e.g. deploying 0.8.5 to the site") }, required: ["text"] } },
  { name: "contacts", description: "Everyone in the chat repository: nick#id, kind, online or last seen, and status.", inputSchema: { type: "object", properties: {} } },
  { name: "groups", description: "Your groups and their members.", inputSchema: { type: "object", properties: {} } },
];

async function call(c: Ctx, name: string, a: Record<string, any>, watcher: () => Promise<Watcher>): Promise<string> {
  const { bus, me } = c;
  const find = async (chat: string, id: string) => {
    const { devices, groups } = await c.load();
    const channel = c.resolveTarget(chat, me, devices, groups);
    const m = (await bus.history(channel, 200)).find((x) => x.id === id || x.id.endsWith(id));
    if (!m) throw new Error(`No message ${id} in ${c.label(channel, me, devices, groups)} (last 200).`);
    return { m, channel, devices, groups };
  };
  switch (name) {
    case "send": {
      const { devices, groups } = await c.load();
      const channel = c.resolveTarget(String(a.to ?? ""), me, devices, groups);
      const m = await bus.send(channel, me, String(a.text ?? ""), [], { replyTo: a.reply || undefined, ask: Array.isArray(a.choices) && a.choices.length ? a.choices.map(String) : undefined });
      await notifyRecipients(m, me, devices, groups).catch(() => {});
      return `sent to ${c.label(channel, me, devices, groups)} (id ${m.id})`;
    }
    case "inbox": {
      const w = await watcher();
      const fresh = (await w.tick()).filter((m) => m.from !== me.id && (a.all || addressedTo(m, me)));
      if (w.head) fs.writeFileSync(c.cursor, w.head);
      if (fresh.length) await bus.markReceipts(me, Object.fromEntries(Object.entries(newestByChannel(fresh)).map(([ch, id]) => [ch, c.readReceipts ? { read: id } : { delivered: id }]))).catch(() => {});
      const recent = new Map(fresh.map((m) => [m.id, m]));
      return fresh.length ? fresh.map((m) => `[${m.id}] ${c.line(m, me, w.devices, w.groups, recent)}`).join("\n") : "No new messages.";
    }
    case "history": {
      const { devices, groups } = await c.load();
      const channel = c.resolveTarget(String(a.chat ?? ""), me, devices, groups);
      const list = await bus.history(channel, Math.min(200, Math.max(1, Number(a.n) || 20)));
      const byId = new Map(list.map((m) => [m.id, m]));
      return list.map((m) => `[${m.id}] ${c.line(m, me, devices, groups, byId)}`).join("\n") || "No messages yet.";
    }
    case "answer": {
      const { m, channel, devices, groups } = await find(String(a.chat ?? ""), String(a.id ?? ""));
      if (!m.ask || m.deleted) throw new Error(`Message ${a.id} has no choices.`);
      if (m.closed) throw new Error(`That question is closed: ${m.closed.note}.`);
      const answer = answerFor(m, String(a.text ?? ""));
      const sent = await bus.send(channel, me, answer.choice === null ? String(a.text) : m.ask[answer.choice], [], { replyTo: m.id, answer });
      await notifyRecipients(sent, me, devices, groups).catch(() => {});
      return answer.choice === null ? "answered (written)" : `answered choice ${answer.choice + 1}: ${sent.text}`;
    }
    case "react": {
      const { m } = await find(String(a.chat ?? ""), String(a.id ?? ""));
      const emoji = a.reaction === "off" ? null : REACTION_NAMES[String(a.reaction)] ?? (REACTIONS as readonly string[]).find((e) => e === a.reaction);
      if (emoji === undefined) throw new Error(`A reaction is ${Object.keys(REACTION_NAMES).join(", ")} or off.`);
      return (await bus.react(me, m, emoji as Reaction | null)) ? (emoji ? `reacted ${emoji}` : "took your reaction back") : "no change";
    }
    case "status": {
      const text = String(a.text ?? "").replace(/\s+/g, " ").trim();
      if (text.length > STATUS_MAX) throw new Error(`A status is ${STATUS_MAX} characters at most.`);
      await bus.heartbeat(me, text);
      c.setStatus(text);
      return text ? `status: ${text}` : "status cleared";
    }
    case "contacts": {
      const [{ devices }, seen] = await Promise.all([c.load(), bus.presence()]);
      return devices.sort((x, y) => x.nick.localeCompare(y.nick)).map((d) => {
        const p = seen[d.id];
        const online = p && Date.now() - Date.parse(p.lastSeen) < 10 * 60_000;
        return `${handle(d)} (${d.kind}${d.id === me.id ? ", you" : ""}) ${online ? "online" : p ? `last seen ${p.lastSeen}` : "never seen"}${online && p.status ? ` — ${p.status}` : ""}`;
      }).join("\n");
    }
    case "groups": {
      const { devices, groups } = await c.load();
      const who = (id: string) => handle(devices.find((d) => d.id === id) ?? { nick: "?", id });
      return groups.filter((g) => g.members.includes(me.id)).map((g) => `#${g.name}: ${g.members.map(who).join(", ")}`).join("\n") || "No groups.";
    }
  }
  throw new Error(`Unknown tool ${name}.`);
}

export async function serveMcp(c: Ctx): Promise<void> {
  const out = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  // inbox's watcher starts at the first call, from where the last session's inbox stopped
  let w: Promise<Watcher> | null = null;
  const watcher = () => (w ??= (async () => {
    const x = new Watcher(c.bus, c.me);
    let from: string | null = null; try { from = fs.readFileSync(c.cursor, "utf8").trim() || null; } catch { /* first time */ }
    await x.start(from);
    return x;
  })());
  // a heartbeat now and every 5 minutes: online while the server runs, with the configured status
  const beat = () => c.bus.heartbeat(c.me, c.status()).catch((e) => console.error(`mcp: heartbeat: ${(e as Error).message}`));
  beat();
  const timer = setInterval(beat, 5 * 60_000);
  const rl = readline.createInterface({ input: process.stdin });
  for await (const text of rl) {
    if (!text.trim()) continue;
    let req: { id?: string | number; method?: string; params?: any };
    try { req = JSON.parse(text); } catch { out({ id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    const { id, method, params } = req;
    if (id === undefined) continue; // a notification (initialized, cancelled): nothing to answer
    try {
      if (method === "initialize") {
        const asked = params?.protocolVersion;
        out({ id, result: { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "opencommunicate", version: c.version },
          instructions: `You are ${handle(c.me)} in the OpenCommunicate chat ${c.repo}. Message ids come first on each line, in [brackets]; use them to reply, answer or react.` } });
      } else if (method === "ping") out({ id, result: {} });
      else if (method === "tools/list") out({ id, result: { tools: TOOLS } });
      else if (method === "tools/call") {
        try { out({ id, result: { content: [{ type: "text", text: await call(c, params?.name, params?.arguments ?? {}, watcher) }] } }); }
        catch (e) { out({ id, result: { content: [{ type: "text", text: (e as Error).message }], isError: true } }); }
      } else out({ id, error: { code: -32601, message: `Unknown method ${method}` } });
    } catch (e) { out({ id, error: { code: -32603, message: (e as Error).message } }); }
  }
  clearInterval(timer);
}
