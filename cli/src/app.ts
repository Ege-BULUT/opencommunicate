/* The agents' own GitHub quota. GitHub counts 5000 calls an hour for an account, shared by everything that uses
   it: the owner's apps on the phone and computers, and every agent that runs with the owner's token. A GitHub App's
   installation is counted apart (5000 an hour of its own), so the agents on a computer move to one:

     1. An agent of the repo owner (its watch, or "opencom app") makes a random ntfy topic and sends the owner, once,
        a link to site/github-app.html. The page hands GitHub a manifest (an app that may read and write the
        repository's contents, nothing else) and the owner taps Create.
     2. GitHub sends the page back with a one-time code; the page posts it to the topic. The agent trades it for the
        app's id and private key (kept on this computer only, in ~/.opencommunicate-apps) and posts the
        install link; the page goes there and the owner taps Install.
     3. The agent sees the installation and every opencom on this computer (each command asks for a token anew)
        speaks with the app's tokens from then on, made for the chat repository alone.

   ponytail: personal repositories only (an organization's apps are made in its settings); and the code crosses
   ntfy in the clear for the few seconds until an agent trades it (one use), as an invite's secret does. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dmChannel, handle, type Bus, type Device, type TokenSource } from "../../core/src/index.ts";
import { post, read } from "../../core/src/invite.ts";

const API = "https://api.github.com";
export const APP_PAGE = "https://opencommunicate.vercel.app/github-app.html";
const DIR = () => process.env.OPENCOM_APPS || path.join(os.homedir(), ".opencommunicate-apps");

type App = { id: number; slug: string; pem: string; owner: string; installation?: number };
type Pending = { topic: string; at: string };
type Note = { kind?: string; code?: unknown; url?: string };

const file = (owner: string, kind: "app" | "pending") => path.join(DIR(), `${owner.toLowerCase()}.${kind}.json`);
const load = <T>(p: string): T | null => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const save = (p: string, v: object, flag = "w") => {
  fs.mkdirSync(DIR(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600, flag });
};

/** The app for a repository owner's agents on this computer, if it was made (and not turned off: OPENCOM_APP=off). */
export const appOf = (owner: string) => (process.env.OPENCOM_APP === "off" ? null : load<App>(file(owner, "app")));

const installUrl = (slug: string, topic: string) => `https://github.com/apps/${slug}/installations/new?state=${topic}`;

/** What the app signs its calls with: a JWT good for ten minutes. */
function jwt(app: App): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(app.id) })}`;
  return `${data}.${crypto.sign("RSA-SHA256", Buffer.from(data), app.pem).toString("base64url")}`;
}
const asApp = (app: App, p: string, init: RequestInit = {}) =>
  fetch(`${API}${p}`, { ...init, headers: { Authorization: `Bearer ${jwt(app)}`, Accept: "application/vnd.github+json" } });

/** The CLI's token: the app's once it is installed (looked for at every call, so a running watch moves to it when
 *  the setup finishes), else `fallback` (OPENCOM_TOKEN or the GitHub CLI's). */
export function tokenSource(repo: string, fallback: () => string): TokenSource {
  const [owner, name] = repo.split("/");
  let made: { token: string; until: number; installation: number } | null = null;
  let plain: string | null = null;
  const current = async () => {
    const app = appOf(owner);
    if (app?.installation) {
      if (made?.installation === app.installation && Date.now() < made.until) return made.token;
      // only for the chat repository, whichever repositories the app was installed on
      const res = await asApp(app, `/app/installations/${app.installation}/access_tokens`, { method: "POST", body: JSON.stringify({ repositories: [name] }) }).catch(() => null);
      if (res?.ok) {
        const d = await res.json();
        made = { token: d.token, until: Date.parse(d.expires_at) - 5 * 60_000, installation: app.installation };
        return made.token;
      }
    }
    return (plain ??= fallback());
  };
  return { current, renew: async () => { made = null; return current(); } };
}

/**
 * One step of setting the app up, for a running watch (every few seconds) and "opencom app". Asks the owner once,
 * trades the code the page posts, waits for the install. True once the app is in use. Only an agent of the repo's
 * owner asks (`asked`: someone ran "opencom app", whatever this device is); `say` tells what happened.
 */
export async function setUpStep(bus: Bus, me: Device, devices: Device[], say: (s: string) => void, asked = false): Promise<boolean> {
  const [owner, name] = bus.repo.split("/");
  const app = appOf(owner);
  if (app?.installation) return true;
  if (process.env.OPENCOM_APP === "off" || me.login?.toLowerCase() !== owner.toLowerCase() || (!asked && me.kind !== "agent")) return false;
  const pendingFile = file(owner, "pending");
  let pending = load<Pending>(pendingFile);
  if (!pending) {
    pending = { topic: crypto.randomBytes(16).toString("hex"), at: new Date().toISOString() };
    try { save(pendingFile, pending, "wx"); } catch { return false; } // another agent here asked first
    const link = `${APP_PAGE}?t=${pending.topic}&o=${encodeURIComponent(owner)}&r=${encodeURIComponent(name)}`;
    // the owner's device seen last: an account can have old ones it no longer reads
    const people = devices.filter((d) => d.kind !== "agent" && d.login?.toLowerCase() === owner.toLowerCase());
    const seen = people.length > 1 ? await bus.presence().catch(() => ({} as Record<string, { lastSeen?: string }>)) : {};
    const person = people.sort((a, b) => (seen[b.id]?.lastSeen ?? "").localeCompare(seen[a.id]?.lastSeen ?? ""))[0];
    if (person) {
      await bus.send(dmChannel(me.id, person.id), me, [
        `This computer's agents can use a GitHub quota of their own and leave yours alone: open the link, tap **Create GitHub App**, then **Install** (the ${name} repository is all it needs).`,
        `Bu bilgisayardaki ajanlar kendi GitHub kotalarını kullanıp seninkine dokunmayabilir: bağlantıyı aç, **Create GitHub App**'e, sonra **Install**'a dokun (yalnızca ${name} reposu yeter).`,
        link,
      ].join("\n\n"));
    }
    say(`app: ${person ? `asked ${handle(person)} to set it up` : "to set it up, open"}: ${link}`);
    return false;
  }
  if (!app) {
    for (const note of await read<Note>(pending.topic, pending.at)) {
      if (note.kind !== "code" || typeof note.code !== "string" || !/^[\w-]{1,100}$/.test(note.code)) continue;
      const res = await fetch(`${API}/app-manifests/${note.code}/conversions`, { method: "POST", headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) continue; // traded already (by another agent here), or not GitHub's
      const d = await res.json();
      if (d.owner?.login?.toLowerCase() !== owner.toLowerCase()) continue; // an app someone else made: not ours
      save(file(owner, "app"), { id: d.id, slug: d.slug, pem: d.pem, owner });
      say(`app: ${d.slug} made; waiting for it to be installed`);
      await post(pending.topic, { kind: "install", url: installUrl(d.slug, pending.topic) });
      return false;
    }
    return false;
  }
  const res = await asApp(app, `/repos/${owner}/${name}/installation`);
  if (!res.ok) {
    // not installed yet: the page waits for the install link; one lost on the way (the process stopped first) goes again
    if (pending && !(await read<Note>(pending.topic, pending.at)).some((n) => n.kind === "install")) {
      await post(pending.topic, { kind: "install", url: installUrl(app.slug, pending.topic) });
      say(`app: ${app.slug}: the install link went to the page again`);
    }
    return false;
  }
  save(file(owner, "app"), { ...app, installation: (await res.json()).id });
  fs.rmSync(pendingFile, { force: true });
  say(`app: ${app.slug} installed; this computer's agents use its own GitHub quota now`);
  return true;
}

/** Forgets a setup that is not finished (the link was lost, or the page closed): the next step asks again. */
export function resetSetUp(owner: string): void {
  fs.rmSync(file(owner, "pending"), { force: true });
  if (!appOf(owner)?.installation) fs.rmSync(file(owner, "app"), { force: true });
}
