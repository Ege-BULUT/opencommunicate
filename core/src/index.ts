/* OpenCommunicate core: a chat bus on top of one private GitHub repository.
 *
 * Every message is its own file, so two devices writing at once never touch the same path; only the
 * branch pointer can race, and a write simply retries on the new head. Devices poll the branch head
 * with an ETag (a "304 Not Modified" does not count against GitHub's rate limit) and, when it moves,
 * ask GitHub which files changed. Works in Node (CLI) and in a browser/WebView (app).
 *
 * Repository layout (protocol 1, see docs/PROTOCOL.md):
 *   opencommunicate.json                 { protocol, name, createdAt }
 *   devices/<id>.json                    { id, nick, kind, login, joinedAt, notify?, quiet? }
 *   channels/all/<message>.json          everyone; also system notices (join, group created)
 *   channels/dm-<a>-<b>/<message>.json   two devices, ids sorted
 *   channels/g-<slug>-<rand>/meta.json   { name, members, admins, createdBy, createdAt } + messages
 *   channels/<ch>/files/<message id>-<name>   attachments
 *   branch "presence": presence/<id>.json   { id, lastSeen } — rewritten, never grows main's history
 */

export const PROTOCOL = 1;

export type Kind = "person" | "phone" | "desktop" | "agent";
/** Per-channel notification setting: only mentions, or nothing; `until` (ISO time) ends it, none means for good. */
export type Quiet = { mode: "mentions" | "off"; until?: string };
export type Device = { id: string; nick: string; kind: Kind; login?: string; joinedAt: string; notify?: string; quiet?: Record<string, Quiet> };
export type Group = { channel: string; name: string; members: string[]; admins?: string[]; createdBy: string; createdAt: string };
export type GroupChange =
  | { type: "add"; ids: string[] }
  | { type: "remove"; id: string }
  | { type: "admin"; id: string; on: boolean }
  | { type: "rename"; name: string }
  | { type: "leave" };
export type FileRef = { name: string; path: string; size: number };
export type Message = {
  v: 1;
  id: string;
  channel: string;
  from: string;
  fromNick: string;
  ts: string;
  text: string;
  files?: FileRef[];
  replyTo?: string;
  system?: { type: "join" | "group" | "change"; device?: Device; group?: Group; change?: GroupChange };
};

export const handle = (d: Pick<Device, "nick" | "id">) => `${d.nick}#${d.id}`;
export const dmChannel = (a: string, b: string) => `dm-${[a, b].sort().join("-")}`;
export const isDm = (ch: string) => /^dm-\d{4}-\d{4}$/.test(ch);
export const dmPeer = (ch: string, me: string) => ch.slice(3).split("-").find((x) => x !== me) ?? me;
/** Group admins. Groups made before admins existed are run by their creator; a group with members always has one. */
export function groupAdmins(g: Group): string[] {
  const admins = (g.admins ?? [g.createdBy]).filter((id) => g.members.includes(id));
  return admins.length ? admins : g.members.slice(0, 1);
}

/**
 * A group after `by` makes `change`; throws when `by` may not make it. Admins add, remove, promote and rename;
 * any member may leave, and when the last admin leaves the longest-standing member takes over. These rights are
 * kept by the clients: whoever can write to the repository could still edit meta.json by hand.
 */
export function applyGroupChange(g: Group, change: GroupChange, by: string): Group {
  if (!g.members.includes(by)) throw new Error("Only members can change the group.");
  const admins = groupAdmins(g);
  const need = () => { if (!admins.includes(by)) throw new Error("Only group admins can do that."); };
  const member = (id: string) => { if (!g.members.includes(id)) throw new Error(`${id} is not in the group.`); };
  switch (change.type) {
    case "add":
      need();
      return { ...g, admins, members: [...new Set([...g.members, ...change.ids])] };
    case "remove":
      need(); member(change.id);
      if (change.id === by) throw new Error("To leave the group, leave it.");
      return { ...g, members: g.members.filter((x) => x !== change.id), admins: admins.filter((x) => x !== change.id) };
    case "admin": {
      need(); member(change.id);
      const next = change.on ? [...new Set([...admins, change.id])] : admins.filter((x) => x !== change.id);
      if (!next.length) throw new Error("A group needs at least one admin.");
      return { ...g, admins: next };
    }
    case "rename": {
      need();
      const name = change.name.trim().slice(0, 40);
      if (!name) throw new Error("A group needs a name.");
      return { ...g, admins, name };
    }
    case "leave": {
      const members = g.members.filter((x) => x !== by);
      const next = admins.filter((x) => x !== by);
      return { ...g, members, admins: next.length ? next : members.slice(0, 1) };
    }
  }
}

/** True when a message is meant for this device: a DM, a mention of @nick / nick#id, or @all / @herkes. */
export function addressedTo(m: Message, me: Pick<Device, "nick" | "id">): boolean {
  if (isDm(m.channel)) return true;
  const nick = me.nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])(@(${nick}(#${me.id})?|all|herkes|everyone)(?![\\w])|${nick}#${me.id}(?!\\d))`, "i").test(m.text ?? "");
}

/** The channel's setting for a device, or null when it gets every notification (none set, or it ran out). */
export function quietFor(d: Pick<Device, "quiet">, channel: string, now = Date.now()): Quiet | null {
  const q = d.quiet?.[channel];
  return q && (!q.until || Date.parse(q.until) > now) ? q : null;
}

/** Whether a device wants to be notified about a message, going by its setting for that channel. */
export function wantsNotice(d: Pick<Device, "nick" | "id" | "quiet">, m: Message, now = Date.now()): boolean {
  const q = quietFor(d, m.channel, now);
  return !q || (q.mode === "mentions" && addressedTo(m, d));
}

const rand = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join("");
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "grup";
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");

// ---------- base64 that works in Node and browsers ----------
const enc = new TextEncoder();
const dec = new TextDecoder();
export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s/g, "");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(clean, "base64"));
  const s = atob(clean);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

type Fetch = typeof fetch;
export type BusOptions = { repo: string; token: string; branch?: string; fetch?: Fetch; api?: string };
type Files = Record<string, Uint8Array | string | null>;
type TreeEntry = { path: string; mode: "100644"; type: "blob"; sha: string | null };

export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class Bus {
  readonly repo: string;
  readonly branch: string;
  private token: string;
  private f: Fetch;
  private api: string;
  private etag = "";
  private blobCache = new Map<string, unknown>();

  constructor(o: BusOptions) {
    this.repo = o.repo;
    this.branch = o.branch ?? "main";
    this.token = o.token;
    this.f = o.fetch ?? ((...a) => fetch(...a));
    this.api = o.api ?? "https://api.github.com";
  }

  // ---------- raw GitHub calls ----------
  async gh<T = any>(path: string, init: RequestInit & { raw?: boolean } = {}): Promise<{ status: number; data: T; headers: Headers }> {
    const res = await this.f(`${this.api}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
    if (res.status === 304) return { status: 304, data: undefined as T, headers: res.headers };
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${res.status} ${path}: ${data?.message ?? text.slice(0, 200)}`);
    return { status: res.status, data, headers: res.headers };
  }
  private r = (p: string) => `/repos/${this.repo}${p}`;

  async head(branch = this.branch): Promise<string | null> {
    try { return (await this.gh(this.r(`/git/ref/heads/${branch}`))).data.object.sha; }
    catch (e) { if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null; throw e; }
  }

  /** Cheap change check: 304 (free) while nothing moved. Returns the new head or null if unchanged. */
  async headIfChanged(): Promise<string | null> {
    const res = await this.gh(this.r(`/git/ref/heads/${this.branch}`), { headers: this.etag ? { "If-None-Match": this.etag } : {} });
    if (res.status === 304) return null;
    this.etag = res.headers.get("etag") ?? "";
    return res.data.object.sha;
  }

  async tree(sha: string): Promise<{ path: string; sha: string; size?: number; type: string }[]> {
    const { data } = await this.gh(this.r(`/git/trees/${sha}?recursive=1`));
    return data.tree;
  }

  async blob(sha: string): Promise<Uint8Array> {
    const { data } = await this.gh(this.r(`/git/blobs/${sha}`));
    return fromBase64(data.content);
  }

  async json<T>(sha: string): Promise<T> {
    if (!this.blobCache.has(sha)) this.blobCache.set(sha, JSON.parse(dec.decode(await this.blob(sha))));
    return this.blobCache.get(sha) as T;
  }

  /**
   * One commit with several files (null deletes). Retries when another device moved the branch meanwhile.
   * `files` can be a function of the head the commit goes on, for changes that read before they write
   * (a group's members): it runs again on every retry, so a concurrent change is never overwritten.
   */
  async commit(files: Files | ((parent: string | null) => Promise<Files>), message: string, opts: { branch?: string; orphan?: boolean } = {}): Promise<string> {
    const branch = opts.branch ?? this.branch;
    const blobs = async (f: Files) => {
      const entries: TreeEntry[] = [];
      for (const [path, content] of Object.entries(f)) {
        if (content === null) { entries.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
        const bytes = typeof content === "string" ? enc.encode(content) : content;
        const { data } = await this.gh(this.r("/git/blobs"), { method: "POST", body: JSON.stringify({ content: toBase64(bytes), encoding: "base64" }) });
        entries.push({ path, mode: "100644", type: "blob", sha: data.sha });
      }
      return entries;
    };
    const fixed = typeof files === "function" ? null : await blobs(files);
    for (let attempt = 0; attempt < 6; attempt++) {
      const parent = await this.head(branch);
      const entries = fixed ?? (await blobs(await (files as (p: string | null) => Promise<Files>)(parent)));
      const baseTree = parent ? (await this.gh(this.r(`/git/commits/${parent}`))).data.tree.sha : undefined;
      const { data: tree } = await this.gh(this.r("/git/trees"), { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree: entries }) });
      const { data: commit } = await this.gh(this.r("/git/commits"), {
        method: "POST",
        body: JSON.stringify({ message, tree: tree.sha, parents: parent && !opts.orphan ? [parent] : [] }),
      });
      try {
        if (parent) await this.gh(this.r(`/git/refs/heads/${branch}`), { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: !!opts.orphan }) });
        else await this.gh(this.r("/git/refs"), { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
        return commit.sha;
      } catch (e) {
        if (!(e instanceof GitHubError) || (e.status !== 422 && e.status !== 409)) throw e;
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1) + Math.random() * 250));
      }
    }
    throw new Error("Could not commit: the branch kept moving. Try again.");
  }

  // ---------- repository setup ----------
  /** Creates the private repository with the template if it doesn't exist; returns true when created. */
  static async ensureRepo(token: string, repo: string, fetchImpl?: Fetch): Promise<boolean> {
    const bus = new Bus({ repo, token, fetch: fetchImpl });
    try {
      await bus.gh(`/repos/${repo}`);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
      const [owner, name] = repo.split("/");
      const me = (await bus.gh("/user")).data.login;
      const path = owner.toLowerCase() === String(me).toLowerCase() ? "/user/repos" : `/orgs/${owner}/repos`;
      await bus.gh(path, { method: "POST", body: JSON.stringify({ name, private: true, auto_init: true, description: "OpenCommunicate chat bus" }) });
      // the new repository's first commit appears a moment later
      for (let i = 0; i < 20 && !(await bus.head()); i++) await new Promise((r) => setTimeout(r, 500));
    }
    const head = await bus.head();
    const files = head ? await bus.tree(head) : [];
    if (files.some((f) => f.path === "opencommunicate.json")) return false;
    await bus.commit({
      "opencommunicate.json": JSON.stringify({ protocol: PROTOCOL, name: repo.split("/")[1], createdAt: new Date().toISOString() }, null, 2) + "\n",
      "README.md": `# ${repo.split("/")[1]}\n\nChat bus for OpenCommunicate (protocol ${PROTOCOL}). Written by the apps; don't edit by hand.\n\n- \`devices/\` who is connected (nick#id)\n- \`channels/all\` everyone, \`channels/dm-*\` two people, \`channels/g-*\` groups\n- one file per message; attachments in each channel's \`files/\`\n`,
      "channels/all/.keep": "",
    }, "Set up OpenCommunicate");
    return true;
  }

  // ---------- directory ----------
  async devices(at?: string): Promise<Device[]> {
    const head = at ?? (await this.head());
    if (!head) return [];
    const entries = (await this.tree(head)).filter((e) => /^devices\/\d{4}\.json$/.test(e.path));
    return Promise.all(entries.map((e) => this.json<Device>(e.sha)));
  }

  async groups(at?: string): Promise<Group[]> {
    const head = at ?? (await this.head());
    if (!head) return [];
    const entries = (await this.tree(head)).filter((e) => /^channels\/g-[a-z0-9-]+\/meta\.json$/.test(e.path));
    return Promise.all(entries.map((e) => this.json<Group>(e.sha)));
  }

  /** Registers this device under a free 4-digit id (or the given one) and announces it in #all. */
  async join(d: { nick: string; kind: Kind; login?: string; id?: string }): Promise<Device> {
    const taken = new Set((await this.devices()).map((x) => x.id));
    let id = d.id;
    if (!id) do { id = String(Math.floor(Math.random() * 9000) + 1000); } while (taken.has(id));
    const device: Device = { id, nick: d.nick.trim().slice(0, 24) || "anon", kind: d.kind, login: d.login, joinedAt: new Date().toISOString() };
    const msg = this.newMessage("all", device, `${handle(device)} joined`, { system: { type: "join", device } });
    await this.commit({ [`devices/${id}.json`]: JSON.stringify(device, null, 2) + "\n", [msgPath(msg)]: JSON.stringify(msg) }, `join: ${handle(device)}`);
    return device;
  }

  async updateDevice(device: Device): Promise<void> {
    await this.commit({ [`devices/${device.id}.json`]: JSON.stringify(device, null, 2) + "\n" }, `device: ${handle(device)}`);
  }

  // ---------- messages ----------
  newMessage(channel: string, from: Device, text: string, extra: Partial<Message> = {}): Message {
    return { v: 1, id: `${stamp()}-${from.id}-${rand(6)}`, channel, from: from.id, fromNick: from.nick, ts: new Date().toISOString(), text, ...extra };
  }

  async send(channel: string, from: Device, text: string, files: { name: string; data: Uint8Array }[] = [], replyTo?: string): Promise<Message> {
    const msg = this.newMessage(channel, from, text, replyTo ? { replyTo } : {});
    const out: Record<string, Uint8Array | string> = {};
    if (files.length) {
      msg.files = files.map((f) => {
        const name = f.name.replace(/[^\w.\-]+/g, "_").slice(-80) || "file";
        const path = `channels/${channel}/files/${msg.id}-${name}`;
        out[path] = f.data;
        return { name: f.name, path, size: f.data.length };
      });
    }
    out[msgPath(msg)] = JSON.stringify(msg);
    await this.commit(out, `msg: ${handle({ nick: from.nick, id: from.id })} → ${channel}`);
    return msg;
  }

  async createGroup(name: string, members: string[], from: Device): Promise<Group> {
    const group: Group = { channel: `g-${slug(name)}-${rand(4)}`, name: name.trim().slice(0, 40), members: [...new Set([from.id, ...members])], admins: [from.id], createdBy: from.id, createdAt: new Date().toISOString() };
    const notice = this.newMessage("all", from, `${handle(from)} created ${group.name}`, { system: { type: "group", group } });
    await this.commit({
      [`channels/${group.channel}/meta.json`]: JSON.stringify(group, null, 2) + "\n",
      [msgPath(notice)]: JSON.stringify(notice),
    }, `group: ${group.name}`);
    return group;
  }

  /** A group as of a commit (the branch head by default). */
  async group(channel: string, at?: string | null): Promise<Group> {
    const ref = at ?? (await this.head());
    try {
      const { data } = await this.gh(this.r(`/contents/channels/${channel}/meta.json${ref ? `?ref=${ref}` : ""}`));
      return JSON.parse(dec.decode(fromBase64(data.content)));
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) throw new Error(`No group ${channel}.`);
      throw e;
    }
  }

  /** Adds, removes, promotes, renames or leaves, with a notice in the group; see applyGroupChange for who may. */
  async changeGroup(channel: string, change: GroupChange, by: Device, devices: Device[] = []): Promise<Group> {
    const who = (id: string) => { const d = devices.find((x) => x.id === id); return d ? handle(d) : `#${id}`; };
    const text = {
      add: () => `${handle(by)} added ${(change as { ids: string[] }).ids.map(who).join(", ")}`,
      remove: () => `${handle(by)} removed ${who((change as { id: string }).id)}`,
      admin: () => {
        const { id, on } = change as { id: string; on: boolean };
        return id === by.id ? `${handle(by)} ${on ? "is now an admin" : "stepped down as admin"}` : `${handle(by)} ${on ? "made" : "removed"} ${who(id)} ${on ? "an admin" : "as admin"}`;
      },
      rename: () => `${handle(by)} renamed the group to ${(change as { name: string }).name.trim().slice(0, 40)}`,
      leave: () => `${handle(by)} left`,
    }[change.type]();
    let result!: Group;
    await this.commit(async (parent) => {
      result = applyGroupChange(await this.group(channel, parent), change, by.id);
      const notice = this.newMessage(channel, by, text, { system: { type: "change", change, group: result } });
      return { [`channels/${channel}/meta.json`]: JSON.stringify(result, null, 2) + "\n", [msgPath(notice)]: JSON.stringify(notice) };
    }, `group: ${text}`);
    return result;
  }

  /** Channels a device follows: #all, every DM with it, and the groups it belongs to. */
  channelsFor(me: string, devices: Device[], groups: Group[]): string[] {
    return ["all", ...devices.filter((d) => d.id !== me).map((d) => dmChannel(me, d.id)), ...groups.filter((g) => g.members.includes(me)).map((g) => g.channel)];
  }

  /** The newest `limit` messages of a channel, oldest first. */
  async history(channel: string, limit = 50, at?: string): Promise<Message[]> {
    const head = at ?? (await this.head());
    if (!head) return [];
    const entries = (await this.tree(head)).filter((e) => e.path.startsWith(`channels/${channel}/`) && isMessagePath(e.path)).sort((a, b) => a.path.localeCompare(b.path));
    return Promise.all(entries.slice(-limit).map((e) => this.json<Message>(e.sha)));
  }

  /** Newest `limit` messages of several channels from one tree listing (app start-up). */
  async histories(channels: string[], limit = 50, at?: string): Promise<Record<string, Message[]>> {
    const head = at ?? (await this.head());
    const out: Record<string, Message[]> = Object.fromEntries(channels.map((c) => [c, []]));
    if (!head) return out;
    const byChannel = new Map<string, { path: string; sha: string }[]>();
    for (const e of await this.tree(head)) {
      if (!isMessagePath(e.path)) continue;
      const ch = e.path.split("/")[1];
      if (ch in out) (byChannel.get(ch) ?? byChannel.set(ch, []).get(ch)!).push(e);
    }
    await Promise.all([...byChannel].map(async ([ch, list]) => {
      list.sort((a, b) => a.path.localeCompare(b.path));
      out[ch] = await Promise.all(list.slice(-limit).map((e) => this.json<Message>(e.sha)));
    }));
    return out;
  }

  /**
   * New messages since `since` (a commit sha) in the given channels. Uses GitHub's compare view, which lists
   * changed files; when that is truncated (300 files) it falls back to a full tree scan against `seen`.
   */
  async changes(since: string, to: string, channels: Set<string>, seen?: Set<string>): Promise<{ messages: Message[]; metaChanged: boolean; devicesChanged: boolean }> {
    let paths: { path: string; sha: string }[];
    let metaChanged = false, devicesChanged = false;
    const { data } = await this.gh(this.r(`/compare/${since}...${to}`));
    const files: { filename: string; sha: string; status: string }[] = data.files ?? [];
    if (files.length >= 300) {
      paths = (await this.tree(to)).filter((e) => isMessagePath(e.path) && !seen?.has(e.path));
      metaChanged = devicesChanged = true;
    } else {
      paths = files.filter((f) => f.status !== "removed").map((f) => ({ path: f.filename, sha: f.sha }));
      metaChanged = paths.some((p) => p.path.endsWith("/meta.json"));
      devicesChanged = paths.some((p) => p.path.startsWith("devices/"));
    }
    const wanted = paths.filter((p) => isMessagePath(p.path) && channels.has(p.path.split("/")[1]) && !seen?.has(p.path));
    const messages = await Promise.all(wanted.map((p) => this.json<Message>(p.sha)));
    wanted.forEach((p) => seen?.add(p.path));
    return { messages: messages.sort((a, b) => a.id.localeCompare(b.id)), metaChanged, devicesChanged };
  }

  async file(path: string): Promise<Uint8Array> {
    const head = await this.head();
    const entry = head ? (await this.tree(head)).find((e) => e.path === path) : undefined;
    if (!entry) throw new Error(`No such file: ${path}`);
    return this.blob(entry.sha);
  }

  // ---------- presence (own branch, rewritten; never adds history to main) ----------
  async heartbeat(me: Device): Promise<void> {
    await this.commit({ [`presence/${me.id}.json`]: JSON.stringify({ id: me.id, lastSeen: new Date().toISOString() }) }, `presence: ${handle(me)}`, { branch: "presence", orphan: true });
  }

  async presence(): Promise<Record<string, string>> {
    const head = await this.head("presence");
    if (!head) return {};
    const entries = (await this.tree(head)).filter((e) => /^presence\/\d{4}\.json$/.test(e.path));
    const all = await Promise.all(entries.map(async (e) => JSON.parse(dec.decode(await this.blob(e.sha))) as { id: string; lastSeen: string }));
    return Object.fromEntries(all.map((p) => [p.id, p.lastSeen]));
  }
}

export const msgPath = (m: Pick<Message, "channel" | "id">) => `channels/${m.channel}/${m.id}.json`;
export const isMessagePath = (p: string) => /^channels\/[a-z0-9-]+\/\d{8}T\d{9}Z-\d{4}-[a-z0-9]{6}\.json$/.test(p);

/**
 * Follows a device's channels: call `tick()` on an interval. Keeps the last head and the paths it has seen,
 * refreshes devices and groups when they change, and returns the new messages for this device.
 */
export class Watcher {
  head: string | null = null;
  seen = new Set<string>();
  devices: Device[] = [];
  groups: Group[] = [];
  private bus: Bus;
  private me: Device;
  private ticks = 0;
  constructor(bus: Bus, me: Device) { this.bus = bus; this.me = me; }

  get channels() { return new Set(this.bus.channelsFor(this.me.id, this.devices, this.groups)); }

  async start(): Promise<void> {
    this.head = await this.bus.head();
    await this.refresh();
    // everything already in this device's channels counts as seen; only new messages are delivered
    if (this.head) {
      const mine = this.channels;
      for (const e of await this.bus.tree(this.head)) if (isMessagePath(e.path) && mine.has(e.path.split("/")[1])) this.seen.add(e.path);
    }
    await this.bus.headIfChanged(); // prime the ETag
  }

  async refresh(): Promise<void> {
    if (!this.head) return;
    [this.devices, this.groups] = await Promise.all([this.bus.devices(this.head), this.bus.groups(this.head)]);
  }

  async tick(): Promise<Message[]> {
    this.ticks++;
    const out: Message[] = [];
    const next = await this.bus.headIfChanged();
    if (next && next !== this.head) {
      if (!this.head) { this.head = next; await this.refresh(); }
      else {
        const res = await this.bus.changes(this.head, next, this.channels, this.seen);
        this.head = next;
        out.push(...res.messages);
        if (res.metaChanged || res.devicesChanged) {
          const before = this.channels;
          await this.refresh();
          // a group this device was just added to: include messages already in it
          const added = [...this.channels].filter((c) => !before.has(c));
          for (const ch of added) for (const m of await this.bus.history(ch, 50, next)) if (!this.seen.has(msgPath(m))) { this.seen.add(msgPath(m)); out.push(m); }
        }
      }
    }
    // Safety net: right after a push GitHub's compare view can come back without the new files, and a
    // message skipped that way would never be read again. Once a minute, scan the tree for anything unseen.
    if (this.head && this.ticks % 12 === 0) out.push(...(await this.reconcile()));
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Messages in this device's channels that are in the repository but were never delivered. */
  async reconcile(): Promise<Message[]> {
    if (!this.head) return [];
    const mine = this.channels;
    const missing = (await this.bus.tree(this.head)).filter((e) => isMessagePath(e.path) && mine.has(e.path.split("/")[1]) && !this.seen.has(e.path));
    const found = await Promise.all(missing.map((e) => this.bus.json<Message>(e.sha)));
    missing.forEach((e) => this.seen.add(e.path));
    return found;
  }
}
