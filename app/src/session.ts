/* Where a session comes from: the desktop CLI (`opencom ui` hands this page its config once), or, on the
   phone, a GitHub device-flow sign-in followed by joining a bus repository. */
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Bus, GitHubError, type Device, type Kind, type TokenSource } from "../../core/src/index.ts";
import { S } from "./i18n.tsx";

/** `account`: the GitHub login this device signed in to the chat with (0.8.1). It picks the stored token, and
 *  only this device's own sign-in sets it: `device.login` mirrors the repository's record of nick#id, which
 *  another device signed in as the same nick#id can change. */
export type Session = { repo: string; token: string; device: Device; source: "desktop" | "app"; account?: string };
const KEY = "oc.session";
// GitHub OAuth app with Device Flow enabled (Ege-BULUT). No secret is needed for the device flow.
const CLIENT_ID = "Ov23liPuqrEbse9N4sDQ";

export const native = () => Capacitor.isNativePlatform();

/** The Electron shell (desktop/): it signs in to GitHub for the page and keeps the Dock/taskbar badge. */
type DesktopShell = {
  signInPost: (url: string, body: Record<string, string>) => Promise<any>; badge: (n: number) => void; focus: () => void;
  // since 0.7.6; older shells lack them
  info?: () => Promise<{ version: string; platform: string; arch: string; selfUpdates: boolean; updateReady: string | null }>;
  onUpdateReady?: (cb: (version: string) => void) => void;
  installUpdate?: () => Promise<void>;
};
export const desktopApp = (): DesktopShell | undefined => (window as { opencomDesktop?: DesktopShell }).opencomDesktop;
/** The web app on the site (https): signs in through the site's /api/github-login. `opencom ui` pages are http. */
export const hosted = () => !native() && !desktopApp() && location.protocol === "https:";
/** Can sign in to GitHub by itself: the phone app, the desktop app or the web app. */
export const canSignIn = () => native() || !!desktopApp() || hosted();

/* A device can be in several chats (0.8.0): every chat it signed in to, each with its own nick#id and token, and
   which one is open, as { chats, active } under "oc.chats". A single session saved before 0.8.0 ("oc.session") is
   read as a list of one, and its read markers move to that chat's own key.
   On the phone the list is also kept in a file in the app's own data folder. The WebView's localStorage is not
   durable storage: Android can drop it, and so does anything that resets the WebView's data, which signed the
   person out with no Sign out pressed. The file is what keeps a sign-in until "Sign out"; localStorage stays as
   the fast copy, and the only one on the web. */
export type Chats = { chats: Session[]; active: string | null };
const CHATS_KEY = "oc.chats";
const FILE = "oc-session.json";
const usable = (s: any): Session | null => (s?.token && s?.device && s?.repo ? s : null);
const same = (a: string, b: string | null) => !!b && a.toLowerCase() === b.toLowerCase();
/** A list from what was stored: { chats, active }, or one session from before 0.8.0. */
export function chatsFrom(x: any): Chats | null {
  if (usable(x)) return { chats: [x], active: x.repo };
  const chats: Session[] = Array.isArray(x?.chats) ? x.chats.filter(usable) : [];
  if (!chats.length) return null;
  return { chats, active: chats.find((c) => same(c.repo, x.active))?.repo ?? chats[0].repo };
}
/** The list with `s` in it (replacing the same repository's entry), open when `open`. */
export const withChat = (c: Chats | null, s: Session, open = false): Chats => {
  const chats = c?.chats.some((x) => same(x.repo, s.repo)) ? c.chats.map((x) => (same(x.repo, s.repo) ? s : x)) : [...(c?.chats ?? []), s];
  return { chats, active: open || !c?.active ? s.repo : c.active };
};
/** The list without `repo`; the next chat opens if it was the open one. */
export const withoutChat = (c: Chats, repo: string): Chats => {
  const chats = c.chats.filter((x) => !same(x.repo, repo));
  return { chats, active: same(repo, c.active) ? chats[0]?.repo ?? null : c.active };
};
const savedAt = (text: string | null | undefined): number => { try { return Number(JSON.parse(text ?? "null")?.savedAt) || 0; } catch { return 0; } };
export const readStored = (): Chats | null => {
  try {
    const list = localStorage.getItem(CHATS_KEY);
    if (list) return chatsFrom(JSON.parse(list));
    const old = chatsFrom(JSON.parse(localStorage.getItem(KEY) ?? "null"));
    // before 0.8.0: one chat, and its read markers under a key every chat would share
    const read = localStorage.getItem("oc.read");
    if (old && read) { localStorage.setItem(`oc.read.${old.chats[0].repo}`, read); localStorage.removeItem("oc.read"); }
    return old;
  } catch { return null; }
};
const writeStored = (text: string) => { try { localStorage.setItem(CHATS_KEY, text); localStorage.removeItem(KEY); } catch { /* private mode: the file still holds it */ } };
// Writes and deletes run one after another, so a sign-out followed by a sign-in can't land out of order.
let fileQueue: Promise<unknown> = Promise.resolve();
const queued = (op: () => Promise<unknown>) => (fileQueue = fileQueue.then(op).catch(() => {}));
const writeFile = (text: string) =>
  queued(() => Filesystem.writeFile({ path: FILE, data: text, directory: Directory.Data, encoding: Encoding.UTF8 }));

async function readText(path: string): Promise<string | null> {
  try {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 });
    return typeof data === "string" ? data : await data.text();
  } catch { return null; }
}

/** The chats this device is in. `opencom ui` hands the page one chat of its own (#k=…), which is not stored. */
export async function loadChats(): Promise<Chats | null> {
  const k = new URLSearchParams(location.hash.slice(1)).get("k");
  if (k) {
    const res = await fetch(`/opencom-config.json?k=${encodeURIComponent(k)}`);
    if (res.ok) { const s: Session = { ...(await res.json()), source: "desktop" }; return { chats: [s], active: s.repo }; }
  }
  if (!native()) {
    const stored = readStored();
    // ask the browser to keep this site's storage under disk pressure (best effort; Safari may still cap it);
    // only once there is a chat to keep, since Firefox asks the person
    if (stored) navigator.storage?.persist?.().catch(() => {});
    return withCreds(stored);
  }
  // the newer of localStorage and the file: a stale localStorage copy must not overwrite a newer file
  const [file, authFile] = await Promise.all([readText(FILE), readText(AUTH_FILE)]);
  mergeAuth(authFile);
  let local: string | null = null; try { local = localStorage.getItem(CHATS_KEY); } catch { /* none */ }
  const stored = readStored();
  if (file && (!stored || savedAt(file) > savedAt(local))) {
    const kept = (() => { try { return chatsFrom(JSON.parse(file)); } catch { return null; } })();
    if (kept) { writeStored(file); return withCreds(kept); }
  }
  if (stored) { await writeFile(JSON.stringify({ ...stored, savedAt: savedAt(local) || Date.now() })); writeAuth(readAuth()); }   // also moves a session saved before 0.5.3
  return withCreds(stored);
}

/** Stores the list (only chats the app signed in to itself; `opencom ui`'s stays with the CLI). */
export function saveChats(c: Chats) {
  const mine = { chats: c.chats.filter((s) => s.source === "app"), active: c.active };
  if (!mine.chats.length) return clearChats();
  const text = JSON.stringify({ ...mine, savedAt: Date.now() });
  writeStored(text);
  if (native()) void writeFile(text);
}
/** Keeps a session's latest state (its device changed, or it was just joined) without opening it. */
export const saveSession = (s: Session) => { if (s.source === "app") saveChats(withChat(readStored(), s)); };
export const clearChats = () => {
  clearSignIn();
  authMem = {};
  try { localStorage.removeItem(KEY); localStorage.removeItem(CHATS_KEY); localStorage.removeItem(AUTH_KEY); } catch { /* nothing stored */ }
  if (native()) {
    void queued(() => Filesystem.deleteFile({ path: FILE, directory: Directory.Data }));
    void queued(() => Filesystem.deleteFile({ path: AUTH_FILE, directory: Directory.Data }));
  }
};

/* GitHub tokens, kept apart from the chat list, one per GitHub account on this device ("oc.auth", and on the
   phone also the file oc-auth.json). Every chat signed in with an account uses its token, so signing in again
   once mends all of them, and a renewed token reaches every chat and every open tab at the next request.
   GitHub's OAuth apps hand out tokens that expire after eight hours, with a refresh token that lasts six months
   from its last use (on by default for apps made since August 2026). The app used to keep only the token, so
   every device asked to sign in again within a day. Now it renews the token itself shortly before it runs out
   and when GitHub answers 401; only a refresh token GitHub refuses ends in "Sign in again".
   (docs.github.com, "Authorizing OAuth apps": refreshing a device-flow token needs no client secret) */
export type Cred = { token: string; refresh?: string; expiresAt?: number; refreshExpiresAt?: number; at: number };
const AUTH_KEY = "oc.auth";
const AUTH_FILE = "oc-auth.json";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
let authMem: Record<string, Cred> = {}; // also the only copy where localStorage throws (private mode)
/** The account a chat signs in with: its GitHub login, or the chat itself for a device that never stored one. */
export const credKey = (s: Pick<Session, "repo" | "device" | "account">) => (s.account || s.device.login || `repo:${s.repo}`).toLowerCase();
const later = (a: Cred | undefined, b: Cred | undefined) => (!a ? b : !b ? a : b.at > a.at ? b : a);
function mergeAuth(text: string | null | undefined) {
  let more: Record<string, Cred> = {};
  try { more = JSON.parse(text ?? "{}") ?? {}; } catch { /* unreadable: keep what we have */ }
  for (const [k, c] of Object.entries(more)) if (c?.token) authMem[k] = later(authMem[k], c)!;
}
let authKept = true; // localStorage holds what this page last wrote (false where setItem threw)
export function readAuth(): Record<string, Cred> {
  // web: localStorage is the copy of record, taken whole, so an account another tab signed out of is gone here
  // too; the phone also keeps what its file held
  try { const t = localStorage.getItem(AUTH_KEY); if (!native() && authKept) takeAuth(t); else mergeAuth(t); } catch { /* private mode: memory only */ }
  return authMem;
}
/** Another tab rewrote "oc.auth" (writers always write the whole map): take it whole, so a sign-out there sticks here. */
export const takeAuth = (text: string | null) => { authMem = {}; mergeAuth(text); };
function writeAuth(a: Record<string, Cred>) {
  authMem = a;
  const text = JSON.stringify(a);
  try { localStorage.setItem(AUTH_KEY, text); authKept = true; } catch { authKept = false; /* private mode */ }
  if (native()) void queued(() => Filesystem.writeFile({ path: AUTH_FILE, data: text, directory: Directory.Data, encoding: Encoding.UTF8 }));
}
export const putCred = (key: string, c: Cred) => writeAuth({ ...readAuth(), [key.toLowerCase()]: c });
/** Forgets one account's token unless a stored chat uses it (a sign-in given up on). */
export function dropCred(key: string) {
  const k = key.toLowerCase();
  if (readStored()?.chats.some((s) => credKey(s) === k)) return;
  const { [k]: _gone, ...rest } = readAuth();
  writeAuth(rest);
}
/** Forgets the tokens no chat in `c` uses any more (after a sign-out). */
export function pruneCreds(c: Chats) {
  const used = new Set(c.chats.map(credKey));
  const a = readAuth();
  writeAuth(Object.fromEntries(Object.entries(a).filter(([k]) => used.has(k))));
}
/** Chats from before 0.8.1 kept their token in the chat itself: those become the account's token. */
function withCreds(c: Chats | null): Chats | null {
  if (!c) return c;
  const a = readAuth(), next = { ...a };
  const pinned = new Map<string, string>(); // repo -> account
  // the open chat's token first; each chat is pinned to the account it uses now, before the repository's device
  // record can move it. An old chat whose token differs from the one another old chat gave the same login may be
  // a second GitHub account (the record moved before this version): it keeps its own token until it signs in again.
  for (const s of [...c.chats.filter((x) => x.repo === c.active), ...c.chats.filter((x) => x.repo !== c.active)]) {
    if (s.source !== "app" || s.account) continue;
    let k = credKey(s);
    if (next[k] && next[k].at === 0 && next[k].token !== s.token) k = `repo:${s.repo}`.toLowerCase();
    next[k] ??= { token: s.token, at: 0 };
    pinned.set(s.repo, k);
  }
  if (pinned.size) writeAuth(next);
  return { ...c, chats: c.chats.map((s) => (pinned.has(s.repo) ? { ...s, account: pinned.get(s.repo) } : s)) };
}
export const credFrom = (d: { access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number }, now = Date.now()): Cred => ({
  token: d.access_token,
  refresh: d.refresh_token || undefined,
  expiresAt: d.expires_in ? now + d.expires_in * 1000 : undefined,
  refreshExpiresAt: d.refresh_token_expires_in ? now + d.refresh_token_expires_in * 1000 : undefined,
  at: now,
});
const runsOut = (c: Cred) => !!c.expiresAt && c.expiresAt - Date.now() < 5 * 60_000;

/* One renewal at a time per account, across this page's chats and the browser's other tabs: GitHub rotates the
   refresh token, so a second renewal with the same one would be refused and sign the account out. */
const chains = new Map<string, Promise<unknown>>();
function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const chained = () => { const run = (chains.get(name) ?? Promise.resolve()).then(fn, fn); chains.set(name, run.catch(() => {})); return run; };
  const locks = (navigator as Navigator & { locks?: { request: (n: string, f: () => Promise<T>) => Promise<T> } }).locks;
  if (!locks?.request) return chained();
  let ran = false; // a refused lock (site data blocked) falls back to this page's own chain
  return locks.request(name, () => { ran = true; return fn(); }).catch((e) => { if (ran) throw e; return chained(); });
}
const tried = new Set<string>(); // old per-chat tokens already tried on this page
const failed = new Map<string, { at: number; e: unknown }>(); // the last renewal per account that GitHub didn't answer

/** A newer token for the account than `rejected`, or null when only signing in again can help (GitHub refused
 *  the refresh token, or there is none). Throws when GitHub can't be reached (passing trouble: the old token
 *  stays and the next request tries again). */
export function renewCred(key: string, rejected: string): Promise<string | null> {
  const asked = Date.now();
  return exclusive(`oc-auth:${key}`, async () => {
    const c = readAuth()[key];
    const gone = () => !!c && !readAuth()[key]; // signed out while GitHub was answering: store nothing
    if (c && c.token !== rejected && !runsOut(c)) return c.token; // another chat or tab renewed it already
    if (c?.refresh) {
      if (!(c.refreshExpiresAt && c.refreshExpiresAt < Date.now())) {
        // GitHub didn't answer the renewal this request waited behind (or one a moment ago): share that answer,
        // rather than every waiting request sending, and waiting for, a POST of its own
        const f = failed.get(key);
        if (f && (f.at >= asked || Date.now() - f.at < 5_000)) throw f.e;
        let data;
        try {
          data = await signInPost(TOKEN_URL, { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: c.refresh });
          // an OAuth error code (bad_refresh_token, ...) is GitHub refusing; anything else is passing trouble
          if (!data?.access_token && !/^[a-z_]+$/.test(data?.error ?? "")) throw new Error(data?.error_description ?? data?.error ?? S.signInFailed);
        } catch (e) { failed.set(key, { at: Date.now(), e }); throw e; } // `at`: when the failure was known
        failed.delete(key);
        if (data.access_token) { if (gone()) return null; const n = credFrom(data); putCred(key, n); return n.token; }
      }
      // refused, or past its six months: never sent again (unless another tab signed in meanwhile)
      const now = readAuth()[key];
      if (now?.refresh === c.refresh) putCred(key, { ...now, refresh: undefined, at: Date.now() });
    }
    // a token another chat of this account kept from before 0.8.1 may still work (each one tried once)
    for (const t of new Set((readStored()?.chats ?? []).filter((s) => credKey(s) === key).map((s) => s.token))) {
      if (t === rejected || t === c?.token || tried.has(t)) continue;
      const res = await gh(t, "/user");
      tried.add(t);
      if (res.ok) { if (gone()) return null; putCred(key, { token: t, at: Date.now() }); return t; }
    }
    return null;
  });
}

/** The token source for a chat's Bus: the account's current token, renewed before it runs out and on a 401. */
export function sourceFor(s: Session): TokenSource {
  if (s.source !== "app") return { current: () => s.token }; // opencom ui: the CLI's own token
  const key = credKey(s);
  return {
    current: async () => {
      const c = readAuth()[key];
      if (!c) return s.token;
      if (runsOut(c) && c.refresh) {
        const renewed = renewCred(key, c.token).catch(() => null);
        // still good for a while: renew in the background, so a slow GitHub doesn't hold this request up
        if (c.expiresAt! - Date.now() > 30_000) return c.token;
        return (await renewed) ?? c.token;
      }
      return c.token;
    },
    renew: (rejected) => renewCred(key, rejected),
  };
}
/** The chat's token as stored now, without renewing it. */
export const currentToken = (s: Session) => (s.source === "app" && readAuth()[credKey(s)]?.token) || s.token;
/** The chat's current token, for the few calls that need the string itself. */
export const tokenFor = async (s: Session) => sourceFor(s).current();

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/* github.com's sign-in endpoints don't allow browser (CORS) requests, so on the phone they go through
   Capacitor's native HTTP. Everything else uses the WebView's own fetch: api.github.com allows CORS, and
   Capacitor's fetch patch sends GETs through a native proxy that can't pass a "304 Not Modified" back, so
   the chat's conditional polling failed with "Failed to fetch" (38 of 40 polls on the emulator). */
// A renewal holds the account's lock, so a request that hangs must give up rather than hold every chat up.
const TIMEOUT = 15_000;
const json = async (res: Response) => { try { return await res.json(); } catch { throw new Error(`GitHub ${res.status}`); } };
async function signInPost(url: string, body: Record<string, string>): Promise<any> {
  const headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  // GitHub rotates the refresh token when it is used, so a renewal answer given up on means signing in again:
  // that one is worth waiting longer for
  const ms = body.grant_type === "refresh_token" ? 60_000 : TIMEOUT;
  if (native()) {
    const d = (await CapacitorHttp.post({ url, headers, data: form(body), connectTimeout: ms, readTimeout: ms })).data;
    return typeof d === "string" ? JSON.parse(d) : d;
  }
  const shell = desktopApp();
  if (shell) return shell.signInPost(url, body);
  const signal = AbortSignal.timeout?.(ms);
  if (hosted()) {
    return json(await fetch("/api/github-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: url.split("/login/")[1], body }), signal }));
  }
  return json(await fetch(url, { method: "POST", headers, body: form(body), signal }));
}

export type DeviceCode = { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };

/* GitHub keeps at most ten tokens per user, app and scope set, and a new sign-in past that revokes the
   least recently used one. The phone, the desktop app, the web app and WeTaskExporter all sign in to
   this one OAuth app, and the phone, closed most of the day, is the least recently used: every sign-in
   elsewhere could cost the phone its token, so it opened with a 401 asking to sign in again. Asking for
   one more scope gives the phone a scope set of its own, so only phone sign-ins share its ten. Since 0.8.1 the
   desktop app has one of its own too, and the phone's has a third scope, because OpenContentManager asks this
   app for "repo read:user" as well.
   (docs.github.com, "Authorizing OAuth apps", creating multiple tokens for OAuth apps) */
const SCOPE = native() ? "repo read:user user:email" : desktopApp() ? "repo user:email" : "repo";

export async function startSignIn(): Promise<DeviceCode> {
  const data = await signInPost("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: SCOPE });
  if (!data.device_code) throw new Error(data.error_description ?? S.signInNotStarted);
  return data;
}

/** Waits until the person approves the code on github.com; resolves with the token (and its refresh token). */
export async function finishSignIn(code: DeviceCode, cancelled: () => boolean): Promise<Cred> {
  let wait = Math.max(5, code.interval) * 1000;
  const until = Date.now() + code.expires_in * 1000;
  while (Date.now() < until && !cancelled()) {
    await new Promise((r) => setTimeout(r, wait));
    let data;
    try {
      data = await signInPost("https://github.com/login/oauth/access_token", { client_id: CLIENT_ID, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    } catch {
      continue; // a dropped connection while waiting is not a reason to give up; ask again next round
    }
    if (data.access_token) return credFrom(data);
    if (data.error === "slow_down") wait += 5000;
    else if (data.error !== "authorization_pending") throw new Error(data.error_description ?? data.error ?? S.signInFailed);
  }
  throw new Error(S.codeExpired);
}

const kindHere = (): Kind => (native() ? "phone" : desktopApp() ? "desktop" : "person");

/** Creates the bus repository if needed and joins it as a new device. */
export async function join(token: string, repo: string, nick: string): Promise<Session> {
  await Bus.ensureRepo(token, repo);
  const bus = new Bus({ repo, token });
  const login = (await bus.gh("/user")).data.login;
  const device = await bus.join({ nick, kind: kindHere(), login });
  return { repo, token, device, source: "app", account: login };
}

/** Signs in as an existing device (nick#id and its password); creates nothing. See Bus.claim. */
export async function claim(token: string, repo: string, handle: string, password: string): Promise<{ session: Session; needsPassword: boolean }> {
  const login = await checkAccount(token, repo); // a repository this account can't see reads as "no such device"
  const { device, needsPassword } = await new Bus({ repo, token }).claim({ handle, password, login, kind: kindHere() });
  return { session: { repo, token, device, source: "app", account: login }, needsPassword };
}

export const setPassword = (s: Session, password: string) => new Bus({ repo: s.repo, token: sourceFor(s) }).setPassword(s.device, password);

/* A sign-in that has not reached the chat yet: the GitHub token, and once joined the new device waiting
   for its password. Kept so a closed tab between "approved on GitHub" and "in the chat" doesn't mean a
   second trip through github.com/login/device. */
export type SignIn = { token: string; login: string; joined?: Session };
const SIGNIN_KEY = "oc.signin";
export const readSignIn = (): SignIn | null => { try { const s = JSON.parse(localStorage.getItem(SIGNIN_KEY) ?? "null"); return s?.token && s?.login ? s : null; } catch { return null; } };
export const saveSignIn = (s: SignIn) => { try { localStorage.setItem(SIGNIN_KEY, JSON.stringify(s)); } catch { /* private mode: sign in again next time */ } };
export const clearSignIn = () => { try { localStorage.removeItem(SIGNIN_KEY); } catch { /* nothing stored */ } };

const gh = (token: string, path: string) => fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });

/** Every repository the account can push to, most recently updated first ("owner/name"). */
export async function listRepos(token: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await gh(token, `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
    if (!res.ok) throw new GitHubError(res.status, `GitHub repos: ${res.status}`);
    const batch: { full_name: string; permissions?: { push?: boolean } }[] = await res.json();
    names.push(...batch.filter((r) => r.permissions?.push !== false).map((r) => r.full_name));
    if (batch.length < 100) break;
  }
  return names;
}

/** Whether "owner/name" exists for this account; a repository it can't see reads as missing, as on GitHub. */
export async function repoExists(token: string, repo: string): Promise<boolean> {
  const res = await gh(token, `/repos/${repo}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new GitHubError(res.status, `GitHub: ${res.status}`);
  return true;
}

/** The account's login; "" when GitHub refuses the token (401). Anything else (offline, rate limit, an outage)
 *  throws, so a passing problem is never read as a revoked token. */
export async function githubLogin(token: string): Promise<string> {
  const res = await gh(token, "/user");
  if (res.status === 401) return "";
  if (!res.ok) throw new GitHubError(res.status, `GitHub ${res.status} /user`);
  return (await res.json()).login ?? "";
}

/** Who the token belongs to; throws a GitHubError when it is invalid or can't read the chat repository. */
export async function checkAccount(token: string | TokenSource, repo: string): Promise<string> {
  const bus = new Bus({ repo, token });
  const login = (await bus.gh("/user")).data.login;
  await bus.gh(`/repos/${repo}`);
  return login;
}

/** A GitHub problem only the person can fix (sign in again, get access), in words; null for passing trouble. */
export function accountProblem(e: unknown, repo: string): string | null {
  if (!(e instanceof GitHubError)) return null;
  if (e.status === 401) return S.bad401;
  if (e.status === 403 && !/rate limit/i.test(e.message)) return S.bad403(repo);
  // GitHub answers 404 for a private repository the account can't see
  if (e.status === 404 && e.message.startsWith(`GitHub 404 /repos/${repo}:`)) return S.bad404(repo);
  return null;
}
