/* Invitations: bringing someone new into a chat without a server.

   1. A member creates invites/<id>.json in the chat repo: who, until when, the SHA-256 of a one-time secret,
      and a random ntfy topic. The link (sent by WhatsApp or anything else) carries the repo, id, secret and
      topic after "#", so it never reaches a server log.
   2. The invitee opens the link, signs in to GitHub, and posts { id, secret, login } to that ntfy topic.
   3. Any open client whose GitHub account administers the repo (an app, or `opencom watch`) reads the topic,
      checks the secret against the hash, adds the login as a collaborator, marks the invite used and posts
      "added". GitHub then holds an invitation, which the invitee's client accepts with its own token.
   The secret works once: the first valid claim uses the invite up. */
import { Bus, GitHubError, handle, type Device } from "./index.ts";

export type Invite = { id: string; by: string; byHandle: string; name?: string; createdAt: string; expiresAt: string; hash: string; topic: string; used?: { login: string; at: string; by: string } };
/** What the link carries. */
export type InviteCode = { r: string; i: string; s: string; t: string; n: string };
type Note = { kind: "claim"; id: string; secret: string; login: string } | { kind: "added"; login: string } | { kind: "refused"; login: string; reason: string };

export const NTFY = "https://ntfy.sh";
export const INVITE_DAYS = 3;
const enc = new TextEncoder();
const rand = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join("");

export async function sha256(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

const b64url = (s: string) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
export const encodeInvite = (c: InviteCode) => b64url(JSON.stringify(c));
/** The invite in a link, a "#invite=…" fragment or a bare code; null when there is none or it is malformed. */
export function decodeInvite(text: string): InviteCode | null {
  const code = text.match(/invite=([\w-]+)/)?.[1] ?? (/^[\w-]{20,}$/.test(text.trim()) ? text.trim() : null);
  if (!code) return null;
  try {
    const c = JSON.parse(unb64url(code));
    // owner/name as GitHub allows them; never "." or ".." (the repo ends up in API paths)
    const repo = typeof c.r === "string" && /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[\w.-]+$/.test(c.r);
    return repo && /^[a-z0-9]+$/.test(c.i) && typeof c.s === "string" && /^opencom-inv-[a-z0-9]+$/.test(c.t) ? c : null;
  } catch { return null; }
}

/** Creates an invite and returns it with the link to send. */
export async function createInvite(bus: Bus, me: Device, opts: { name?: string; base: string }): Promise<{ invite: Invite; link: string }> {
  const secret = rand(24);
  const invite: Invite = {
    id: rand(10), by: me.id, byHandle: handle(me), ...(opts.name ? { name: opts.name.slice(0, 40) } : {}),
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + INVITE_DAYS * 86400e3).toISOString(),
    hash: await sha256(secret), topic: `opencom-inv-${rand(20)}`,
  };
  await bus.commit({ [`invites/${invite.id}.json`]: JSON.stringify(invite, null, 2) + "\n" }, `invite: by ${invite.byHandle}`);
  const link = `${opts.base}#invite=${encodeInvite({ r: bus.repo, i: invite.id, s: secret, t: invite.topic, n: invite.byHandle })}`;
  return { invite, link };
}

export async function invites(bus: Bus, at?: string): Promise<Invite[]> {
  const head = at ?? (await bus.head());
  if (!head) return [];
  const entries = (await bus.tree(head)).filter((e) => /^invites\/[a-z0-9]+\.json$/.test(e.path));
  return Promise.all(entries.map((e) => bus.json<Invite>(e.sha)));
}
export const isOpen = (i: Invite, now = Date.now()) => !i.used && Date.parse(i.expiresAt) > now;

// ---------- the ntfy topic ----------
export async function post(topic: string, note: Note, f: typeof fetch = fetch): Promise<void> {
  await f(`${NTFY}/${topic}`, { method: "POST", body: JSON.stringify(note) });
}
/** Notes posted to a topic since a time (ntfy keeps them about 12 hours). */
export async function read(topic: string, since: string, f: typeof fetch = fetch): Promise<Note[]> {
  const res = await f(`${NTFY}/${topic}/json?poll=1&since=${Math.floor(Date.parse(since) / 1000)}`);
  if (!res.ok) return [];
  const out: Note[] = [];
  for (const line of (await res.text()).split("\n")) {
    try { const m = JSON.parse(line); if (m.event === "message") out.push(JSON.parse(m.message)); } catch { /* not ours */ }
  }
  return out;
}

/** Can this token add collaborators to the chat repo? Only then does a client process invites. */
export async function canAdmit(bus: Bus): Promise<boolean> {
  try { return !!(await bus.gh(`/repos/${bus.repo}`)).data.permissions?.admin; } catch { return false; }
}

/**
 * Admits whoever claimed an open invite with the right secret. Returns the logins admitted this time.
 * A login that already has access (the owner, a collaborator) counts as admitted.
 */
export async function processInvites(bus: Bus, me: Device, f: typeof fetch = fetch): Promise<string[]> {
  const done: string[] = [];
  for (const inv of (await invites(bus)).filter((i) => isOpen(i))) {
    for (const note of await read(inv.topic, inv.createdAt, f)) {
      if (note.kind !== "claim" || note.id !== inv.id || !/^[A-Za-z0-9-]{1,39}$/.test(note.login)) continue;
      if ((await sha256(note.secret)) !== inv.hash) { await post(inv.topic, { kind: "refused", login: note.login, reason: "Davet bağlantısı geçersiz." }, f); continue; }
      // the owner is in already (GitHub refuses to make the owner a collaborator: 422 "Validation Failed")
      if (note.login.toLowerCase() !== bus.repo.split("/")[0].toLowerCase()) {
        try {
          await bus.gh(`/repos/${bus.repo}/collaborators/${note.login}`, { method: "PUT", body: JSON.stringify({ permission: "push" }) });
        } catch (e) {
          if (!(e instanceof GitHubError)) throw e;
          const reason = e.status === 404 ? `GitHub'da ${note.login} diye bir kullanıcı yok.` : `GitHub eklemeyi reddetti (${e.status}).`;
          await post(inv.topic, { kind: "refused", login: note.login, reason }, f);
          continue;
        }
      }
      const used: Invite = { ...inv, used: { login: note.login, at: new Date().toISOString(), by: me.id } };
      await bus.commit({ [`invites/${inv.id}.json`]: JSON.stringify(used, null, 2) + "\n" }, `invite: ${note.login} admitted by ${handle(me)}`);
      await post(inv.topic, { kind: "added", login: note.login }, f);
      done.push(note.login);
      break; // one use
    }
  }
  return done;
}

/** Invitee side: accepts GitHub's pending invitation to the repo, if there is one. True once the repo is reachable. */
export async function acceptInvitation(token: string, repo: string, f?: typeof fetch): Promise<boolean> {
  const bus = new Bus({ repo, token, ...(f ? { fetch: f } : {}) }); // the Bus binds the global fetch itself
  try { await bus.gh(`/repos/${repo}`); return true; } catch { /* not yet */ }
  const pending = (await bus.gh<{ id: number; repository: { full_name: string } }[]>("/user/repository_invitations")).data;
  const mine = pending.find((p) => p.repository.full_name.toLowerCase() === repo.toLowerCase());
  if (!mine) return false;
  await bus.gh(`/user/repository_invitations/${mine.id}`, { method: "PATCH" });
  return true;
}

/** Where invite links point: the web app, which works on any phone or computer. */
export const INVITE_BASE = "https://opencommunicate.vercel.app/app/";

/** The message that goes with an invite link (WhatsApp, e-mail, anything). */
export function inviteMessage(link: string, by: string, repo: string, name?: string): string {
  return [
    `Merhaba${name ? ` ${name}` : ""}! ${by} seni OpenCommunicate'teki "${repo.split("/")[1]}" sohbetine davet ediyor.`,
    "OpenCommunicate'te kişiler ve yapay zekâ ajanları özel bir GitHub reposu üzerinden ücretsiz mesajlaşır.",
    "",
    `1. Bağlantıyı aç: ${link}`,
    "2. GitHub ile giriş yap. Hesabın yoksa github.com'da ücretsiz açabilirsin.",
    "3. Sohbete kendiliğinden eklenirsin. Sayfa, telefonuna (Android ya da iPhone) veya bilgisayarına göre sonraki adımı gösterir.",
    "",
    `Bağlantı ${INVITE_DAYS} gün geçerli ve tek kullanımlık; başkasıyla paylaşma.`,
  ].join("\n");
}

/** wa.me link for a phone number in any common format (+90 5xx…, 05xx…, 905xx…). */
export function whatsappLink(phone: string, text: string): string {
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  else if (digits.startsWith("0")) digits = `90${digits.slice(1)}`; // a Turkish number written the local way
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
