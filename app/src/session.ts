/* Where a session comes from: the desktop CLI (`opencom ui` hands this page its config once), or, on the
   phone, a GitHub device-flow sign-in followed by joining a bus repository. */
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { Bus, GitHubError, type Device } from "../../core/src/index.ts";

export type Session = { repo: string; token: string; device: Device; source: "desktop" | "app" };
const KEY = "oc.session";
// GitHub OAuth app with Device Flow enabled (Ege-BULUT). No secret is needed for the device flow.
const CLIENT_ID = "Ov23liPuqrEbse9N4sDQ";

export const native = () => Capacitor.isNativePlatform();

export async function loadSession(): Promise<Session | null> {
  const k = new URLSearchParams(location.hash.slice(1)).get("k");
  if (k) {
    const res = await fetch(`/opencom-config.json?k=${encodeURIComponent(k)}`);
    if (res.ok) return { ...(await res.json()), source: "desktop" };
  }
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return s?.token && s?.device ? s : null;
  } catch { return null; }
}

export const saveSession = (s: Session) => { if (s.source === "app") localStorage.setItem(KEY, JSON.stringify(s)); };
export const clearSession = () => localStorage.removeItem(KEY);

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
  return (await fetch(url, { method: "POST", headers, body: form(body) })).json();
}

export type DeviceCode = { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };

export async function startSignIn(): Promise<DeviceCode> {
  const data = await signInPost("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: "repo" });
  if (!data.device_code) throw new Error(data.error_description ?? "GitHub did not start the sign-in.");
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
    else if (data.error !== "authorization_pending") throw new Error(data.error_description ?? data.error ?? "Sign-in failed.");
  }
  throw new Error("The code expired. Start again.");
}

/** Creates the bus repository if needed and joins it as this phone. */
export async function join(token: string, repo: string, nick: string): Promise<Session> {
  await Bus.ensureRepo(token, repo);
  const bus = new Bus({ repo, token });
  const login = (await bus.gh("/user")).data.login;
  const device = await bus.join({ nick, kind: native() ? "phone" : "person", login });
  return { repo, token, device, source: "app" };
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
  if (e.status === 401) return "GitHub oturumu geçersiz ya da iptal edilmiş (401). Yeniden giriş yapın.";
  if (e.status === 403 && !/rate limit/i.test(e.message)) return `Bu GitHub hesabının ${repo} reposuna erişimi yok (403). Repo sahibi sizi collaborator olarak eklemeli.`;
  // GitHub answers 404 for a private repository the account can't see
  if (e.status === 404 && e.message.startsWith(`GitHub 404 /repos/${repo}:`)) return `${repo} reposu bulunamadı ya da bu hesap onu göremiyor (404). Repo sahibi sizi collaborator olarak eklemeli.`;
  return null;
}
