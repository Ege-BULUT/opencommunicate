/* End-to-end encryption (0.9.0). GitHub, and anyone who can read the repository, sees who wrote to which chat and
   when, but not what. Everything here is WebCrypto, so the apps, the CLI and the MCP server share it.

   - Each account (nick#id) has a P-256 key pair. Its public key is keys/<id>.json on the "keys" branch. The
     private key stays on the device; for a person it also sits there locked with the account's password
     (PBKDF2 → AES-GCM), so another device signing in as the same nick#id unlocks it.
   - Each chat has a key per epoch: channels/<channel>/<epoch>.json holds it wrapped for each member (ECDH with a
     one-off key → HKDF → AES-GCM). A sender uses the newest epoch it holds. Members missing from it are added,
     with every older epoch the sender holds (a new member reads the history, as before); when someone has left,
     the sender starts a new epoch without them, so they read nothing after.
   - A message's text, files (names, previews, bytes), choices and earlier versions are sealed with its chat's
     key (AES-GCM, the message's channel/id as associated data). Routing stays plain: id, chat, sender, time,
     quotes, answers, reactions, receipts. Drafts are sealed with a key only the account derives. */
import { fromBase64, rand, stamp, toBase64, type Bus, type Message } from "./index.ts";

export type Sealed = { k: string; iv: string; ct: string }; // k: the epoch
export type Wrapped = { epk: string; iv: string; ct: string };
export type Epoch = { v: 1; epoch: string; by: string; for: Record<string, Wrapped> };
export type KeyBackup = { kdf: "PBKDF2-SHA256"; iter: number; salt: string; iv: string; ct: string };
export type PublicKey = { v: 1; pub: string; backup?: KeyBackup };
/** An account's key pair as a device keeps it: SPKI and PKCS8, base64. */
export type Identity = { pub: string; priv: string };

/** What an old app shows for an encrypted message, and what a message says when this device has no key for it. */
export const SEALED_TEXT = "🔒 Encrypted message. Update OpenCommunicate (0.9.0 or later) to read it.";

const subtle = globalThis.crypto.subtle;
const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (b: ArrayBuffer | Uint8Array) => toBase64(b instanceof Uint8Array ? b : new Uint8Array(b));
const bytes = (s: string) => fromBase64(s) as Uint8Array<ArrayBuffer>;
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const aesKey = (raw: BufferSource) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

async function seal(key: CryptoKey, data: Uint8Array, aad: string): Promise<{ iv: string; ct: string }> {
  const iv = random(12);
  return { iv: b64(iv), ct: b64(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, data as BufferSource)) };
}
async function open(key: CryptoKey, iv: string, ct: string, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: bytes(iv), additionalData: enc.encode(aad) }, key, bytes(ct)));
}
/** An AES key from an ECDH secret, bound to what it is for. */
async function agree(priv: CryptoKey, pub: CryptoKey, info: string): Promise<CryptoKey> {
  const secret = await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hkdf = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(info) }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const importPub = (spki: string) => subtle.importKey("spki", bytes(spki), EC, false, []);
const importPriv = (pkcs8: string) => subtle.importKey("pkcs8", bytes(pkcs8), EC, false, ["deriveBits"]);

export async function newIdentity(): Promise<Identity> {
  const k = (await subtle.generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
  return { pub: b64(await subtle.exportKey("spki", k.publicKey)), priv: b64(await subtle.exportKey("pkcs8", k.privateKey)) };
}

const ITER = 310_000;
const passwordKey = async (password: string, salt: Uint8Array<ArrayBuffer>, iter: number) =>
  subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, await subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
/** The private key locked with the account's password, to keep next to the public key. */
export async function backupKey(id: Identity, password: string): Promise<KeyBackup> {
  const salt = random(16);
  return { kdf: "PBKDF2-SHA256", iter: ITER, salt: b64(salt), ...(await seal(await passwordKey(password, salt, ITER), bytes(id.priv), `opencommunicate key ${id.pub}`)) };
}
/** The key pair back from its backup; throws on a wrong password. */
export async function restoreKey(pub: PublicKey, password: string): Promise<Identity> {
  const b = pub.backup!;
  const priv = await open(await passwordKey(password, bytes(b.salt), b.iter), b.iv, b.ct, `opencommunicate key ${pub.pub}`).catch(() => { throw new WrongPassword(); });
  return { pub: pub.pub, priv: b64(priv) };
}
export class WrongPassword extends Error { constructor() { super("Wrong password."); } }

async function wrap(raw: Uint8Array, to: string, info: string): Promise<Wrapped> {
  const one = (await subtle.generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
  return { epk: b64(await subtle.exportKey("spki", one.publicKey)), ...(await seal(await agree(one.privateKey, await importPub(to), info), raw, info)) };
}
async function unwrap(w: Wrapped, priv: CryptoKey, info: string): Promise<Uint8Array<ArrayBuffer>> {
  return open(await agree(priv, await importPub(w.epk), info), w.iv, w.ct, info);
}

/** The fields a message keeps sealed. */
type Secret = Pick<Message, "text" | "files" | "ask" | "edits">;
const SECRET = ["text", "files", "ask", "edits"] as const;

/**
 * This device's keys for a chat repository: its account's key pair, and the chats' keys from the "keys" branch.
 * `members(channel)` says who is in a chat now (ids).
 */
export class Keyring {
  private priv!: CryptoKey;
  private self!: Promise<CryptoKey>;
  private head: string | null = null;
  pubs = new Map<string, PublicKey>();
  private epochs = new Map<string, Epoch[]>(); // by channel, oldest first
  private keys = new Map<string, Promise<CryptoKey | null>>(); // channel/epoch
  private bus: Bus;
  readonly me: string;
  readonly id: Identity;
  private members: (channel: string) => Promise<string[]>;
  constructor(bus: Bus, me: string, id: Identity, members: (channel: string) => Promise<string[]>) { this.bus = bus; this.me = me; this.id = id; this.members = members; }

  static async load(bus: Bus, me: string, id: Identity, members: (channel: string) => Promise<string[]>): Promise<Keyring> {
    const k = new Keyring(bus, me, id, members);
    k.priv = await importPriv(id.priv);
    k.self = importPub(id.pub).then((pub) => agree(k.priv, pub, `opencommunicate self ${me}`));
    await k.sync();
    return k;
  }

  /** Reads the "keys" branch again if it moved; true when it did. One read at a time. */
  private syncing: Promise<boolean> | null = null;
  sync(): Promise<boolean> {
    return (this.syncing ??= this.read().finally(() => { this.syncing = null; }));
  }
  private async read(): Promise<boolean> {
    const head = await this.bus.headIfChanged("keys");
    if (!head || head === this.head) return false;
    const pubs = new Map<string, PublicKey>(), epochs = new Map<string, Epoch[]>();
    await Promise.all((await this.bus.tree(head)).map(async (e) => {
      const p = e.path.match(/^keys\/(\d{4})\.json$/), c = e.path.match(/^channels\/([a-z0-9-]+)\/[^/]+\.json$/);
      if (p) pubs.set(p[1], await this.bus.json<PublicKey>(e.sha));
      else if (c) { const ep = await this.bus.json<Epoch>(e.sha); (epochs.get(c[1]) ?? epochs.set(c[1], []).get(c[1])!).push(ep); }
    }));
    for (const list of epochs.values()) list.sort((a, b) => a.epoch.localeCompare(b.epoch));
    const newcomers = [...pubs.keys()].some((id) => !this.pubs.has(id));
    this.head = head; this.pubs = pubs; this.epochs = epochs;
    if (newcomers) this.fill().catch(() => {});
    return true;
  }

  /** Members who published a key after a chat's newest epoch was made get it, and the older ones, from whoever
   *  holds it and looks first: so someone who installs the update reads what was sent before. */
  private filling = false;
  private async fill(): Promise<void> {
    if (this.filling) return;
    this.filling = true;
    try {
      for (const [channel, list] of this.epochs) {
        const newest = list.at(-1);
        if (!newest?.for[this.me]) continue;
        const members = await this.members(channel).catch(() => [] as string[]);
        const missing = members.filter((id) => this.pubs.has(id) && !newest.for[id]);
        if (missing.length) await this.share(channel, missing).catch(() => {});
      }
    } finally { this.filling = false; }
  }

  private info = (channel: string, epoch: string, id: string) => `opencommunicate chat ${channel} ${epoch} ${id}`;
  /** A chat's key of one epoch, if it is wrapped for this account. */
  key(channel: string, epoch: string): Promise<CryptoKey | null> {
    const at = `${channel}/${epoch}`;
    const w = this.epochs.get(channel)?.find((e) => e.epoch === epoch)?.for[this.me];
    if (!w) return Promise.resolve(null); // not cached: it may be wrapped for me on a later sync
    if (!this.keys.has(at)) this.keys.set(at, unwrap(w, this.priv, this.info(channel, epoch, this.me)).then(aesKey, () => null));
    return this.keys.get(at)!;
  }

  /** The epoch to send with: the newest this account holds, wrapped for everyone in the chat now (members who
   *  lack it get it, and the older ones; a chat someone left starts a new epoch). */
  async sending(channel: string): Promise<{ epoch: string; key: CryptoKey }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.sync(); // keys published or epochs made since the last look
      const members = [...new Set([...(await this.members(channel)), this.me])].filter((id) => this.pubs.has(id) || id === this.me);
      const mine = [...(this.epochs.get(channel) ?? [])].reverse().find((e) => e.for[this.me]);
      const current = mine && mine === this.epochs.get(channel)!.at(-1) ? mine : null;
      const left = current && Object.keys(current.for).some((id) => !members.includes(id));
      if (current && !left) {
        const missing = members.filter((id) => !current.for[id]);
        if (missing.length) await this.share(channel, missing);
        return { epoch: current.epoch, key: (await this.key(channel, current.epoch))! };
      }
      // no epoch yet, a newer one this account is not in, or one that still includes someone who left
      const raw = random(32), epoch = `${stamp()}-${rand(4)}`;
      const ep: Epoch = { v: 1, epoch, by: this.me, for: {} };
      for (const id of members) ep.for[id] = await wrap(raw, id === this.me ? this.id.pub : this.pubs.get(id)!.pub, this.info(channel, epoch, id));
      try {
        await this.bus.commit({ [`channels/${channel}/${epoch}.json`]: JSON.stringify(ep) }, `key: ${channel} ${epoch}`, { branch: "keys" });
        await this.sync();
        this.keys.set(`${channel}/${epoch}`, aesKey(raw));
        return { epoch, key: await aesKey(raw) };
      } catch (e) { if (attempt === 2) throw e; await this.sync(); }
    }
    throw new Error("Could not set up the chat's key.");
  }

  /** Wraps every epoch of `channel` this account holds for `ids` too. */
  async share(channel: string, ids: string[]): Promise<void> {
    await this.bus.commit(async () => {
      await this.sync();
      const out: Record<string, string> = {};
      for (const ep of this.epochs.get(channel) ?? []) {
        const key = ep.for[this.me] && (await unwrap(ep.for[this.me], this.priv, this.info(channel, ep.epoch, this.me)).catch(() => null));
        if (!key) continue;
        const add = ids.filter((id) => !ep.for[id] && this.pubs.has(id));
        if (!add.length) continue;
        const next = { ...ep, for: { ...ep.for } };
        for (const id of add) next.for[id] = await wrap(key, this.pubs.get(id)!.pub, this.info(channel, ep.epoch, id));
        out[`channels/${channel}/${ep.epoch}.json`] = JSON.stringify(next);
      }
      return out;
    }, `key: share ${channel}`, { branch: "keys" });
    await this.sync();
  }

  /** A message with its secret fields sealed, and a placeholder for older apps. */
  async seal(m: Message): Promise<Message> {
    const { epoch, key } = await this.sending(m.channel);
    const secret = Object.fromEntries(SECRET.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
    const out: Message = { ...m, text: SEALED_TEXT, enc: { k: epoch, ...(await seal(key, enc.encode(JSON.stringify(secret)), `${m.channel}/${m.id}`)) } };
    for (const k of SECRET) if (k !== "text") delete out[k];
    return out;
  }
  /** A message with its sealed fields back; `locked` when this account has no key for it (yet). */
  async open(m: Message): Promise<Message> {
    if (!m.enc) return m;
    // an epoch made since the last read of the keys: read them again
    const key = (await this.key(m.channel, m.enc.k)) ?? ((await this.sync()) ? await this.key(m.channel, m.enc.k) : null);
    if (!key) return { ...m, locked: true };
    try {
      const secret = JSON.parse(dec.decode(await open(key, m.enc.iv, m.enc.ct, `${m.channel}/${m.id}`))) as Secret;
      const { locked: _l, ...rest } = m;
      return { ...rest, ...secret, text: secret.text ?? "" };
    } catch { return { ...m, locked: true }; }
  }

  /** A file's bytes sealed with the chat's key (`aad`: its path). */
  async sealBytes(channel: string, data: Uint8Array, aad: string): Promise<{ k: string; iv: string; data: Uint8Array }> {
    const { epoch, key } = await this.sending(channel);
    const s = await seal(key, data, aad);
    return { k: epoch, iv: s.iv, data: bytes(s.ct) };
  }
  async openBytes(channel: string, epoch: string, iv: string, data: Uint8Array, aad: string): Promise<Uint8Array> {
    const key = (await this.key(channel, epoch)) ?? ((await this.sync()) ? await this.key(channel, epoch) : null);
    if (!key) throw new Error("This device has no key for that file yet.");
    return open(key, iv, b64(data), aad);
  }

  /** Something only this account reads (its drafts). */
  async sealSelf(text: string, aad: string): Promise<{ iv: string; ct: string }> { return seal(await this.self, enc.encode(text), aad); }
  async openSelf(s: { iv: string; ct: string }, aad: string): Promise<string> { return dec.decode(await open(await this.self, s.iv, s.ct, aad)); }

  /** Something everyone in a chat reads (a status line, sealed with #all's key). */
  async sealFor(channel: string, text: string, aad: string): Promise<Sealed> { const { epoch, key } = await this.sending(channel); return { k: epoch, ...(await seal(key, enc.encode(text), aad)) }; }
  async openFor(channel: string, s: Sealed, aad: string): Promise<string | null> {
    const key = (await this.key(channel, s.k)) ?? ((await this.sync()) ? await this.key(channel, s.k) : null);
    return key ? open(key, s.iv, s.ct, aad).then((b) => dec.decode(b), () => null) : null;
  }
}

/**
 * Sets up this device's keys: its own (`stored`), or the account's from its backup unlocked with `password()`, or
 * a new pair, published with a backup when a password is given. `password(reason)` asks the person (null: not
 * now); agents have none. Returns null while the account's key stays locked on this device.
 */
export async function setUpKeys(bus: Bus, me: string, o: {
  stored: Identity | null; save: (id: Identity) => void; password?: (reason: "unlock" | "protect") => Promise<string | null>;
  members: (channel: string) => Promise<string[]>;
}): Promise<Keyring | null> {
  const path = `keys/${me}.json`;
  const published = await bus.readJson<PublicKey>(path, await bus.head("keys"));
  let id = o.stored;
  if (!id && published?.backup) {
    for (;;) {
      const pw = await o.password?.("unlock");
      if (!pw) return null;
      try { id = await restoreKey(published, pw); break; } catch (e) { if (!(e instanceof WrongPassword)) throw e; }
    }
    o.save(id);
  }
  if (!id) {
    id = await newIdentity();
    o.save(id);
  }
  if (published?.pub !== id.pub) {
    // new, or replacing a key this account can no longer unlock (its older encrypted messages stay unreadable)
    const pw = published?.backup ? null : await o.password?.("protect");
    const doc: PublicKey = { v: 1, pub: id.pub, ...(pw ? { backup: await backupKey(id, pw) } : {}) };
    await bus.commit({ [path]: JSON.stringify(doc) }, `key: ${me}`, { branch: "keys" });
  }
  return Keyring.load(bus, me, id, o.members);
}

/** After a password is set or changed: the account's private key locked with it, next to the public key. */
export async function backUpKeys(bus: Bus, me: string, id: Identity, password: string): Promise<void> {
  await bus.commit({ [`keys/${me}.json`]: JSON.stringify({ v: 1, pub: id.pub, backup: await backupKey(id, password) } satisfies PublicKey) }, `key: ${me} backup`, { branch: "keys" });
}
