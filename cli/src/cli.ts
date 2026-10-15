/* opencom: the OpenCommunicate command line, for people and for agents (any harness that can run a
   command). Token: OPENCOM_TOKEN, else the GitHub CLI's (`gh auth token`). Config: ~/.opencommunicate/config.json. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Bus, PALETTES, PHOTO_MAX, REACTIONS, REACTION_NAMES, Watcher, searchMessages, reactionsOn, type Reaction, type Reactions, addressedTo, newestByChannel, recipientsOf, snippet, ticksFor, dmChannel, groupAdmins, handle, isDm, dmPeer, pictureOf, type Device, type Group, type GroupChange, type Kind, type Message } from "../../core/src/index.ts";
import { notifyRecipients } from "../../core/src/notify.ts";
import { INVITE_BASE, canAdmit, createInvite, inviteMessage, invites, isOpen, processInvites, whatsappLink } from "../../core/src/invite.ts";

const CONFIG_DIR = process.env.OPENCOM_HOME || path.join(os.homedir(), ".opencommunicate");
const CONFIG = path.join(CONFIG_DIR, "config.json");
type Config = { repo: string; device: Device; readReceipts?: boolean };

const USAGE = `opencom — chat over a private GitHub repository

  opencom init <owner/repo> --nick <name> [--kind agent|desktop|person]
                                   create the repo if needed and join it
  opencom whoami                   this device
  opencom contacts                 everyone connected (nick#id, last seen)
  opencom send <to> <text…> [--file <path>]… [--reply <message-id>]
                                   to: all | nick#1234 | 1234 | <group name>;
                                   --reply quotes a message in that chat (its id, from history/watch)
  opencom history <to> [-n 20] [--edits]
                                   recent messages; yours end in ✓ sent, ✓✓ delivered or ✓✓ read;
                                   an edited one says (edited), --edits lists what it said before
  opencom search <text…> [--chat <to>] [-n 20]
                                   messages (and attachment names) containing the text, newest first,
                                   in all your chats or one; reads the whole history, so it takes a while
  opencom edit <chat> <id> <text…> change the text of one of your messages; everyone gets a notice
                                   ("… edited a message: <new text>") at the end of the chat
  opencom delete <chat> <id>       delete one of your messages for everyone (text and files go;
                                   a notice says a message was deleted)
  opencom forward <to> <id…> --from <chat>
                                   forward one or more messages (by id, from --from's recent
                                   history) into another chat; someone else's is marked "forwarded"
  opencom pin <chat> <id…> [--off] pin messages (by id, from the chat's recent history) for this account
                                   only, like WhatsApp's starred messages (--off: unpin)
  opencom pins [<chat>]            this account's pinned messages, newest pin first
  opencom react <chat> <id> <reaction> [--off]
                                   react to a message: up 👍, down 👎, smile 🙂 or heart ❤️ (the emoji
                                   works too); one per message, a new one replaces it (--off: take it back).
                                   history shows them after each message: [👍 ege#1234]
  opencom watch [--json] [--interval 5] [--to-me] [--once]
                                   print new messages as they arrive (JSON lines with --json;
                                   "toMe" is true for DMs and for @nick, nick#1234 or @all);
                                   --to-me prints only those; --once exits after the first new
                                   messages, and the next --once starts where it stopped, so an
                                   agent can run it in the background and be woken when it exits
  opencom groups                   your groups, their members and admins (★)
  opencom group create <name> <member…>
                                   create a group; you are its admin (members: nick#1234 or 1234)
  opencom group add <group> <member…>      admins: add members
  opencom group remove <group> <member>    admins: remove a member
  opencom group admin <group> <member> [--off]
                                   admins: make a member an admin (--off: take it back)
  opencom group rename <group> <name…>     admins: rename
  opencom group leave <group>      leave (if you were the last admin, the next member takes over)
  opencom picture [--random] [--seed <text>] [--palette <name>] [--photo <file>] [--reset]
                                   this device's profile picture: generated art (agents get one
                                   by default) or a photo of 50 KB at most
  opencom invite [--name <name>] [--phone <number>] [--lang en|tr]
                                   a one-time link for someone new (and a WhatsApp link with --phone);
                                   the message is in --lang, else the system language ($LANG), else English;
                                   "opencom invites" lists them. Whoever administers the repo lets the
                                   invitee in: the app, or "opencom watch", does it while running
  opencom notify on|off            phone notifications through ntfy for this device
  opencom receipts on|off          read receipts: "watch" tells senders it read their messages
                                   (blue ticks); off still reports them delivered (default: on)
  opencom ui [--port 4817]         open the desktop app in the browser
`;

function token(): string {
  if (process.env.OPENCOM_TOKEN) return process.env.OPENCOM_TOKEN;
  try { return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim(); }
  catch { throw new Error("No GitHub token: set OPENCOM_TOKEN or sign in with `gh auth login`."); }
}
const readConfig = (): Config => {
  try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); }
  catch { throw new Error("Not set up yet. Run: opencom init <owner/repo> --nick <name>"); }
};
const readText = (p: string) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const writeConfig = (c: Config) => { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 }); };

function flags(args: string[]) {
  const out: Record<string, string[]> = {}, rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") || /^-[a-z]$/.test(a)) {
      const k = a.replace(/^-+/, "");
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) (out[k] ??= []).push("true");
      else { (out[k] ??= []).push(next); i++; }
    } else rest.push(a);
  }
  return { f: out, rest };
}

export function resolveTarget(to: string, me: Device, devices: Device[], groups: Group[]): string {
  const t = to.trim();
  if (t === "all" || t === "#all") return "all";
  const id = t.match(/^(?:.*#)?(\d{4})$/)?.[1];
  if (id) {
    if (!devices.some((d) => d.id === id)) throw new Error(`No one with id ${id}. See: opencom contacts`);
    return dmChannel(me.id, id);
  }
  const g = groups.find((x) => x.channel === t || x.name.toLowerCase() === t.toLowerCase());
  if (!g) throw new Error(`Unknown recipient "${to}". Use all, nick#1234 or a group name.`);
  if (!g.members.includes(me.id)) throw new Error(`You are not in ${g.name}.`);
  return g.channel;
}

export function label(ch: string, me: Device, devices: Device[], groups: Group[]): string {
  if (ch === "all") return "#all";
  if (isDm(ch)) { const d = devices.find((x) => x.id === dmPeer(ch, me.id)); return d ? `@${handle(d)}` : ch; }
  return `#${groups.find((g) => g.channel === ch)?.name ?? ch}`;
}

const members = (g: Group, devices: Device[]) => {
  const admins = groupAdmins(g);
  return g.members.map((id) => `${handle(devices.find((d) => d.id === id) ?? { nick: "?", id })}${admins.includes(id) ? " ★" : ""}`).join(", ");
};

const local = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const line = (m: Message, me: Device, devices: Device[], groups: Group[], quoted?: Map<string, Message>, reactions?: Reactions) => {
  const q = m.replyTo ? quoted?.get(m.replyTo) : undefined;
  const quote = m.replyTo ? `  ↩ ${q ? `${q.fromNick}: ${snippet(q, 48)}` : `(message ${m.replyTo.slice(-6)})`}` : "";
  const who = m.forwarded ? "forwarded" : `${m.fromNick}#${m.from}`;
  const name = (id: string) => handle(devices.find((d) => d.id === id) ?? { nick: "?", id });
  const rs = reactions ? reactionsOn(m, reactions) : [];
  const reacted = rs.length ? `  [${rs.map((r) => `${r.emoji} ${r.ids.map(name).join(", ")}`).join(" · ")}]` : "";
  const body = m.deleted ? "(deleted)" : `${m.text}${m.edited ? " (edited)" : ""}`;
  return `${local(m.ts)}  ${label(m.channel, me, devices, groups)}  ${who}: ${body}${m.files?.length ? `  [${m.files.map((f) => f.name).join(", ")}]` : ""}${quote}${reacted}`;
};

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  const { f, rest } = flags(args);
  if (!cmd || cmd === "help" || f.help) { process.stdout.write(USAGE); return; }

  if (cmd === "init") {
    const repo = rest[0];
    if (!repo?.includes("/") || !f.nick) throw new Error("Usage: opencom init <owner/repo> --nick <name> [--kind agent]");
    const t = token();
    const created = await Bus.ensureRepo(t, repo);
    const bus = new Bus({ repo, token: t });
    const login = (await bus.gh("/user")).data.login;
    const device = await bus.join({ nick: f.nick[0], kind: (f.kind?.[0] as Kind) ?? "desktop", login });
    writeConfig({ repo, device });
    console.log(`${created ? "Created" : "Joined"} ${repo} as ${handle(device)}.`);
    return;
  }

  const cfg = readConfig();
  const bus = new Bus({ repo: cfg.repo, token: token() });
  const me = cfg.device;
  const load = async () => { const head = await bus.head(); return { devices: await bus.devices(head ?? undefined), groups: await bus.groups(head ?? undefined) }; };

  switch (cmd) {
    case "whoami":
      console.log(`${handle(me)} (${me.kind}) in ${cfg.repo}`);
      return;
    case "contacts": {
      const [{ devices }, seen] = await Promise.all([load(), bus.presence()]);
      for (const d of devices.sort((a, b) => a.nick.localeCompare(b.nick))) {
        const last = seen[d.id];
        const online = last && Date.now() - Date.parse(last) < 10 * 60_000;
        console.log(`${online ? "●" : "○"} ${handle(d).padEnd(20)} ${d.kind.padEnd(8)} ${last ? `seen ${local(last)}` : ""}${d.id === me.id ? "  (you)" : ""}`);
      }
      return;
    }
    case "send": {
      const [to, ...words] = rest;
      if (!to) throw new Error("Usage: opencom send <to> <text…> [--file <path>]");
      const text = words.join(" ");
      const files = (f.file ?? []).map((p) => ({ name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) }));
      if (!text && !files.length) throw new Error("Nothing to send.");
      const { devices, groups } = await load();
      const channel = resolveTarget(to, me, devices, groups);
      const msg = await bus.send(channel, me, text, files, f.reply ? { replyTo: f.reply[0] } : {});
      await notifyRecipients(msg, me, devices, groups).catch(() => {});
      console.log(`sent to ${label(channel, me, devices, groups)}`);
      return;
    }
    case "history": {
      const { devices, groups } = await load();
      const channel = resolveTarget(rest[0] ?? "all", me, devices, groups);
      const [list, receipts, reactions] = await Promise.all([bus.history(channel, Number(f.n?.[0] ?? 20)), bus.receipts(), bus.reactions()]);
      const to = recipientsOf(channel, me.id, devices, groups);
      const byId = new Map(list.map((m) => [m.id, m]));
      const mark = { sent: "✓", delivered: "✓✓", read: "✓✓ read" };
      for (const m of list) {
        console.log(line(m, me, devices, groups, byId, reactions) + (m.from === me.id && !m.system ? `  ${mark[ticksFor(m, to, receipts, cfg.readReceipts !== false)]}` : ""));
        if (f.edits) for (const e of m.edits ?? []) console.log(`    before ${local(e.at)}: ${e.text}`);
      }
      return;
    }
    case "groups": {
      const { devices, groups } = await load();
      const mine = groups.filter((g) => g.members.includes(me.id));
      if (!mine.length) console.log("No groups yet. Create one: opencom group create <name> <member…>");
      for (const g of mine) console.log(`#${g.name}  ${members(g, devices)}`);
      return;
    }
    case "group": {
      const sub = ["create", "add", "remove", "admin", "rename", "leave"].includes(rest[0]) ? rest.shift()! : "create"; // "opencom group <name> …" still creates
      const { devices, groups } = await load();
      const idOf = (w: string) => {
        const id = w.match(/^(?:.*#)?(\d{4})$/)?.[1];
        if (!id || !devices.some((d) => d.id === id)) throw new Error(`Unknown member ${w}. See: opencom contacts`);
        return id;
      };
      if (sub === "create") {
        const [name, ...who] = rest;
        if (!name) throw new Error("Usage: opencom group create <name> <member…>");
        const g = await bus.createGroup(name, who.map(idOf), me);
        console.log(`created #${g.name} with ${members(g, devices)}`);
        return;
      }
      const [target, ...more] = rest;
      if (!target) throw new Error(`Usage: see opencom help`);
      const channel = resolveTarget(target, me, devices, groups);
      if (!channel.startsWith("g-")) throw new Error(`${target} is not a group.`);
      const change: GroupChange =
        sub === "add" ? { type: "add", ids: more.map(idOf) }
        : sub === "remove" ? { type: "remove", id: idOf(more[0] ?? "") }
        : sub === "admin" ? { type: "admin", id: idOf(more[0] ?? ""), on: !f.off }
        : sub === "rename" ? { type: "rename", name: more.join(" ") }
        : { type: "leave" };
      if (change.type === "add" && !change.ids.length) throw new Error("Usage: opencom group add <group> <member…>");
      const g = await bus.changeGroup(channel, change, me, devices);
      console.log(change.type === "leave" ? `left #${g.name}` : `#${g.name}  ${members(g, devices)}`);
      return;
    }
    case "picture": {
      const current = pictureOf(me);
      const describe = (p: typeof current) => !p ? "initials" : "photo" in p ? `photo ${p.photo}` : `art, seed "${p.seed}", palette ${p.palette}`;
      if (f.palette && !PALETTES.some((p) => p.id === f.palette[0])) throw new Error(`Palettes: ${PALETTES.map((p) => p.id).join(", ")}`);
      let next: Device;
      if (f.photo) {
        const data = fs.readFileSync(f.photo[0]);
        if (data.length > PHOTO_MAX) throw new Error(`${f.photo[0]} is ${Math.round(data.length / 1024)} KB; a profile photo can be 50 KB at most. Shrink it first (macOS: sips -Z 256 -s format jpeg in.jpg --out out.jpg) or pick it in the app, which shrinks it for you.`);
        next = await bus.setPicture(me, { photo: new Uint8Array(data), ext: path.extname(f.photo[0]).slice(1) || "jpg" });
      } else if (f.reset) {
        next = await bus.setPicture(me, null);
      } else if (f.random || f.seed || f.palette) {
        const art = current && "seed" in current ? current : null;
        const seed = f.seed?.[0] ?? (f.random ? crypto.randomUUID().slice(0, 8) : art?.seed ?? me.id);
        next = await bus.setPicture(me, { seed, palette: f.palette?.[0] ?? art?.palette ?? PALETTES[0].id });
      } else {
        console.log(`${handle(me)}: ${describe(current)}${me.picture ? "" : " (default)"}. Palettes: ${PALETTES.map((p) => p.id).join(", ")}`);
        return;
      }
      writeConfig({ ...cfg, device: next });
      console.log(`${handle(me)}: ${describe(pictureOf(next))}`);
      return;
    }
    case "invite": {
      const name = f.name?.[0];
      const { link } = await createInvite(bus, me, { name, base: INVITE_BASE });
      const lang = f.lang?.[0] ?? (/^tr/i.test(process.env.LC_ALL || process.env.LANG || "") ? "tr" : "en");
      if (lang !== "en" && lang !== "tr") throw new Error("--lang is en or tr");
      const text = inviteMessage(link, handle(me), cfg.repo, name, lang);
      console.log(text);
      if (f.phone) console.log(`\nWhatsApp: ${whatsappLink(f.phone[0], text)}`);
      if (!(await canAdmit(bus))) console.log("\nNote: this GitHub account doesn't administer the repo; an admin's app or `opencom watch` must be running to let the invitee in.");
      return;
    }
    case "invites": {
      for (const i of await invites(bus)) console.log(`${i.id}  by ${i.byHandle}${i.name ? ` for ${i.name}` : ""}  ${i.used ? `used by ${i.used.login} ${local(i.used.at)}` : isOpen(i) ? `open until ${local(i.expiresAt)}` : "expired"}`);
      return;
    }
    case "notify": {
      const on = rest[0] !== "off";
      const next: Device = { ...me, notify: on ? me.notify ?? `https://ntfy.sh/opencom-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}` : undefined };
      await bus.updateDevice(next);
      writeConfig({ ...cfg, device: next });
      console.log(on ? `Notifications on. Subscribe to this topic in the ntfy app: ${next.notify}` : "Notifications off.");
      return;
    }
    case "receipts": {
      if (rest[0] !== "on" && rest[0] !== "off") { console.log(`Read receipts are ${cfg.readReceipts === false ? "off" : "on"}.`); return; }
      writeConfig({ ...cfg, readReceipts: rest[0] === "on" });
      console.log(rest[0] === "on" ? "Read receipts on: senders see blue ticks once watch has printed their message." : "Read receipts off: senders only see that their message was delivered.");
      return;
    }
    case "forward": {
      const [to, ...ids] = rest;
      if (!to || !ids.length || !f.from) throw new Error("Usage: opencom forward <to> <message-id…> --from <chat>");
      const { devices, groups } = await load();
      const dest = resolveTarget(to, me, devices, groups);
      const src = resolveTarget(f.from[0], me, devices, groups);
      const hist = await bus.history(src, 200);
      const pick = ids.map((id) => { const m = hist.find((x) => x.id === id || x.id.endsWith(id)); if (!m) throw new Error(`No message ${id} in ${label(src, me, devices, groups)} (last 200).`); return m; });
      const sent = await bus.forward(dest, me, pick);
      await Promise.all(sent.map((m) => notifyRecipients(m, me, devices, groups).catch(() => {})));
      console.log(`forwarded ${sent.length} to ${label(dest, me, devices, groups)}`);
      return;
    }
    case "pin": {
      const [to, ...ids] = rest;
      if (!to || !ids.length) throw new Error("Usage: opencom pin <chat> <message-id…> [--off]");
      const { devices, groups } = await load();
      const channel = resolveTarget(to, me, devices, groups);
      const hist = await bus.history(channel, 200);
      const pick = ids.map((id) => { const m = hist.find((x) => x.id === id || x.id.endsWith(id)); if (!m) throw new Error(`No message ${id} in ${label(channel, me, devices, groups)} (last 200).`); return m; });
      const pins = await bus.setPins(me, pick, !f.off);
      console.log(`${f.off ? "unpinned" : "pinned"} ${pick.length} in ${label(channel, me, devices, groups)}; ${pins.length} pinned in all`);
      return;
    }
    case "search": {
      const text = rest.join(" ");
      if (!text.trim()) throw new Error("Usage: opencom search <text…> [--chat <to>] [-n 20]");
      const { devices, groups } = await load();
      const channels = f.chat ? [resolveTarget(f.chat[0], me, devices, groups)] : bus.channelsFor(me.id, devices, groups);
      const { messages } = await bus.older(channels, new Set(), Infinity);
      const found = searchMessages(messages, text).slice(0, Number(f.n?.[0] ?? 20));
      if (!found.length) console.log(`Nothing found for "${text}" in ${messages.length} messages.`);
      for (const m of found.reverse()) console.log(`${line(m, me, devices, groups)}  (id ${m.id})`);
      return;
    }
    case "edit":
    case "delete": {
      const [to, id, ...words] = rest;
      if (!to || !id || (cmd === "edit" && !words.length)) throw new Error(cmd === "edit" ? "Usage: opencom edit <chat> <message-id> <text…>" : "Usage: opencom delete <chat> <message-id>");
      const { devices, groups } = await load();
      const channel = resolveTarget(to, me, devices, groups);
      const m = (await bus.history(channel, 200)).find((x) => x.id === id || x.id.endsWith(id));
      if (!m) throw new Error(`No message ${id} in ${label(channel, me, devices, groups)} (last 200).`);
      await bus.amend(me, m, cmd === "edit" ? words.join(" ") : null);
      console.log(`${cmd === "edit" ? "edited" : "deleted"} in ${label(channel, me, devices, groups)}`);
      return;
    }
    case "react": {
      const [to, id, word] = rest;
      if (!to || !id || (!word && !f.off)) throw new Error(`Usage: opencom react <chat> <message-id> <${Object.keys(REACTION_NAMES).join("|")}> [--off]`);
      const emoji = word ? REACTION_NAMES[word.toLowerCase()] ?? (REACTIONS as readonly string[]).find((e) => e.replace("\ufe0f", "") === word.replace("\ufe0f", "")) : undefined;
      if (word && !emoji && !f.off) throw new Error(`A reaction is ${Object.entries(REACTION_NAMES).map(([k, e]) => `${k} ${e}`).join(", ")}.`);
      const { devices, groups } = await load();
      const channel = resolveTarget(to, me, devices, groups);
      const m = (await bus.history(channel, 200)).find((x) => x.id === id || x.id.endsWith(id));
      if (!m) throw new Error(`No message ${id} in ${label(channel, me, devices, groups)} (last 200).`);
      const changed = await bus.react(me, m, f.off ? null : (emoji as Reaction));
      console.log(!changed ? "no change" : f.off ? `took back your reaction in ${label(channel, me, devices, groups)}` : `reacted ${emoji} in ${label(channel, me, devices, groups)}`);
      return;
    }
    case "pins": {
      const { devices, groups } = await load();
      const only = rest[0] ? resolveTarget(rest[0], me, devices, groups) : null;
      const pins = (await bus.pins(me.id)).filter((p) => !only || p.channel === only);
      if (!pins.length) console.log("No pinned messages. Pin one: opencom pin <chat> <message-id>");
      const found = await Promise.all(pins.map((p) => bus.message(p.channel, p.id)));
      pins.forEach((p, i) => console.log(found[i] ? line(found[i], me, devices, groups) : `${label(p.channel, me, devices, groups)}  (deleted message ${p.id.slice(-6)})`));
      return;
    }
    case "watch": {
      // Two sessions on one identity both get every message and both answer it: say so at once.
      const pidFile = path.join(CONFIG_DIR, "watch.pid");
      const other = Number(readText(pidFile)) || 0;
      if (other && other !== process.pid && alive(other)) console.error(`watch: another watch (pid ${other}) is listening as ${handle(me)}; both get every message and both will answer. Give each session its own identity: OPENCOM_HOME=~/.opencommunicate-<name> opencom init ${cfg.repo} --nick <name> --kind agent`);
      else fs.writeFileSync(pidFile, String(process.pid));
      // where the last watch stopped, so --once picks up what arrived while nothing was listening
      const cursor = path.join(CONFIG_DIR, "watch-head");
      const w = new Watcher(bus, me);
      await w.start(f.once ? readText(cursor) : null);
      const recent = new Map<string, Message>(); // a small window so a reply can show what it quotes
      const every = Math.max(2, Number(f.interval?.[0] ?? 5)) * 1000;
      let beat = 0;
      // an admin's watch also lets invited people in (every 15 s)
      const admits = await canAdmit(bus);
      let invitesAt = 0;
      if (!f.json) console.error(`watching ${cfg.repo} as ${handle(me)}…`);
      for (;;) {
        try {
          if (Date.now() - beat > 5 * 60_000) { beat = Date.now(); bus.heartbeat(me).catch(() => {}); }
          if (admits && Date.now() - invitesAt > 15_000) {
            invitesAt = Date.now();
            for (const login of await processInvites(bus, me)) console.error(`watch: admitted ${login} (invitation)`);
          }
          const fresh = await w.tick();
          for (const m of fresh) recent.set(m.id, m);
          const shown = fresh.filter((m) => (m.from !== me.id || f.all) && (!f["to-me"] || addressedTo(m, me)));
          for (const m of shown) {
            const quoted = m.replyTo ? recent.get(m.replyTo) : undefined;
            console.log(f.json
              ? JSON.stringify({ ...m, channelLabel: label(m.channel, me, w.devices, w.groups), toMe: addressedTo(m, me), replyPreview: quoted ? { from: quoted.from, fromNick: quoted.fromNick, text: snippet(quoted) } : undefined })
              : line(m, me, w.devices, w.groups, recent));
          }
          if (w.head) fs.writeFileSync(cursor, w.head);
          // what watch printed has reached this session: delivered, and read unless read receipts are off
          const others = shown.filter((m) => m.from !== me.id);
          if (others.length) {
            const newest = newestByChannel(others);
            const read = cfg.readReceipts !== false;
            const sent = bus.markReceipts(me, Object.fromEntries(Object.entries(newest).map(([ch, id]) => [ch, read ? { read: id } : { delivered: id }])))
              .catch((e) => console.error(`watch: receipts: ${(e as Error).message}`));
            if (f.once) { await sent; return; }
          }
        } catch (e) {
          console.error(`watch: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, every));
      }
    }
    case "ui": {
      const port = Number(f.port?.[0] ?? 4817);
      const dist = [path.join(import.meta.dirname, "app"), path.join(import.meta.dirname, "..", "..", "app", "dist")].find((d) => fs.existsSync(path.join(d, "index.html")));
      if (!dist) throw new Error("The app is not built. Run: npm run build");
      const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
      const secret = crypto.randomUUID();
      http.createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        // The page gets this device's config and token once, from this machine only.
        if (u.pathname === "/opencom-config.json") {
          if (u.searchParams.get("k") !== secret) { res.writeHead(403); return res.end(); }
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          return res.end(JSON.stringify({ repo: cfg.repo, device: me, token: token() }));
        }
        const file = path.join(dist, path.normalize(u.pathname === "/" ? "/index.html" : u.pathname));
        if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end(fs.readFileSync(path.join(dist, "index.html")));
        }
        res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
        fs.createReadStream(file).pipe(res);
      }).listen(port, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${port}/#k=${secret}`;
        console.log(`OpenCommunicate is open at ${url}`);
        try { execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [url]); } catch { /* open it by hand */ }
      });
      return;
    }
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(`opencom: ${(e as Error).message}`); process.exit(1); });
