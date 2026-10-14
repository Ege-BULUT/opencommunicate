/* Where a session comes from: the desktop CLI (`opencom ui` hands this page its config once), or, on the
   phone, a GitHub device-flow sign-in followed by joining a bus repository. */
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Bus, GitHubError, type Device, type Kind } from "../../core/src/index.ts";
import { S } from "./i18n.tsx";

export type Session = { repo: string; token: string; device: Device; source: "desktop" | "app" };
const KEY = "oc.session";
// GitHub OAuth app with Device Flow enabled (Ege-BULUT). No secret is needed for the device flow.
const CLIENT_ID = "Ov23liPuqrEbse9N4sDQ";

export const native = () => Capacitor.isNativePlatform();

/** The Electron shell (desktop/): it signs in to GitHub for the page and keeps the Dock/taskbar badge. */
type DesktopShell = { signInPost: (url: string, body: Record<string, string>) => Promise<any>; badge: (n: number) => void; focus: () => void };
export const desktopApp = (): DesktopShell | undefined => (window as { opencomDesktop?: DesktopShell }).opencomDesktop;
/** The web app on the site (https): signs in through the site's /api/github-login. `opencom ui` pages are http. */
export const hosted = () => !native() && !desktopApp() && location.protocol === "https:";
/** Can sign in to GitHub by itself: the phone app, the desktop app or the web app. */
export const canSignIn = () => native() || !!desktopApp() || hosted();

/* On the phone the session is also kept in a file in the app's own data folder. The WebView's
   localStorage is not durable storage: Android can drop it, and so does anything that resets the
   WebView's data, which signed the person out with no Sign out pressed. The file is what keeps a
   sign-in until "Çıkış yap"; localStorage stays as the fast copy, and the only one on the web. */
const FILE = "oc-session.json";
const usable = (s: any): Session | null => (s?.token && s?.device ? s : null);
const readStored = () => { try { return usable(JSON.parse(localStorage.getItem(KEY) ?? "null")); } catch { return null; } };
const writeStored = (text: string) => { try { localStorage.setItem(KEY, text); } catch { /* private mode: the file still holds it */ } };
// Writes and deletes run one after another, so a sign-out followed by a sign-in can't land out of order.
let fileQueue: Promise<unknown> = Promise.resolve();
const queued = (op: () => Promise<unknown>) => (fileQueue = fileQueue.then(op).catch(() => {}));
const writeFile = (text: string) =>
  queued(() => Filesystem.writeFile({ path: FILE, data: text, directory: Directory.Data, encoding: Encoding.UTF8 }));

async function readFile(): Promise<Session | null> {
  try {
    const { data } = await Filesystem.readFile({ path: FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
    return usable(JSON.parse(typeof data === "string" ? data : await data.text()));
  } catch { return null; }
}

export async function loadSession(): Promise<Session | null> {
  const k = new URLSearchParams(location.hash.slice(1)).get("k");
  if (k) {
    const res = await fetch(`/opencom-config.json?k=${encodeURIComponent(k)}`);
    if (res.ok) return { ...(await res.json()), source: "desktop" };
  }
  const stored = readStored();
  if (!native()) return stored;
  if (stored) { await writeFile(JSON.stringify(stored)); return stored; }   // also moves a session saved before 0.5.3
  const kept = await readFile();
  if (kept) writeStored(JSON.stringify(kept));
  return kept;
}

export const saveSession = (s: Session) => {
  if (s.source !== "app") return;
  const text = JSON.stringify(s);
  writeStored(text);
  if (native()) void writeFile(text);
};
export const clearSession = () => {
  clearSignIn();
  try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
  if (native()) void queued(() => Filesystem.deleteFile({ path: FILE, directory: Directory.Data }));
};

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/* github.com's sign-in endpoints don't allow browser (CORS) requests, so on the phone they go through
   Capacitor's native HTTP. Everything else uses the WebView's own fetch: api.github.com allows CORS, and
   Capacitor's fetch patch sends GETs through a native proxy that can't pass a "304 Not Modified" back, so
   the chat's conditional polling failed with "Failed to fetch" (38 of 40 polls on the emulator). */
async function signInPost(url: string, body: Record<string, string>): Promise<any> {
  const headers = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
  if (native()) {
    const d = (await CapacitorHttp.post({ url, headers, data: form(body) })).data;
    return typeof d === "string" ? JSON.parse(d) : d;
  }
  const shell = desktopApp();
  if (shell) return shell.signInPost(url, body);
  if (hosted()) {
    const res = await fetch("/api/github-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: url.split("/login/")[1], body }) });
    return res.json();
  }
  return (await fetch(url, { method: "POST", headers, body: form(body) })).json();
}

export type DeviceCode = { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };

/* GitHub keeps at most ten tokens per user, app and scope set, and a new sign-in past that revokes the
   least recently used one. The phone, the desktop app, the web app and WeTaskExporter all sign in to
   this one OAuth app, and the phone, closed most of the day, is the least recently used: every sign-in
   elsewhere could cost the phone its token, so it opened with a 401 asking to sign in again. Asking for
   one more scope gives the phone a scope set of its own, so only phone sign-ins share its ten.
   (docs.github.com, "Authorizing OAuth apps", creating multiple tokens for OAuth apps) */
const SCOPE = native() ? "repo read:user" : "repo";

export async function startSignIn(): Promise<DeviceCode> {
  const data = await signInPost("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: SCOPE });
  if (!data.device_code) throw new Error(data.error_description ?? S.signInNotStarted);
  return data;
}

/** Waits until the person approves the code on github.com; resolves with the token. */
export async function finishSignIn(code: DeviceCode, cancelled: () => boolean): Promise<string> {
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
    if (data.access_token) return data.access_token;
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
  return { repo, token, device, source: "app" };
}

/** Signs in as an existing device (nick#id and its password); creates nothing. See Bus.claim. */
export async function claim(token: string, repo: string, handle: string, password: string): Promise<{ session: Session; needsPassword: boolean }> {
  const login = await checkAccount(token, repo); // a repository this account can't see reads as "no such device"
  const { device, needsPassword } = await new Bus({ repo, token }).claim({ handle, password, login, kind: kindHere() });
  return { session: { repo, token, device, source: "app" }, needsPassword };
}

export const setPassword = (s: Session, password: string) => new Bus({ repo: s.repo, token: s.token }).setPassword(s.device, password);

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

export async function githubLogin(token: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}` } });
  return (await res.json()).login;
}

/** Who the token belongs to; throws a GitHubError when it is invalid or can't read the chat repository. */
export async function checkAccount(token: string, repo: string): Promise<string> {
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
