/* Where a session comes from: the desktop CLI (`opencom ui` hands this page its config once), or, on the
   phone, a GitHub device-flow sign-in followed by joining a bus repository. */
import { Capacitor } from "@capacitor/core";
import { Bus, type Device } from "../../core/src/index.ts";

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

export type DeviceCode = { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };

export async function startSignIn(): Promise<DeviceCode> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: CLIENT_ID, scope: "repo" }),
  });
  const data = await res.json();
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
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ client_id: CLIENT_ID, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      data = await res.json();
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
