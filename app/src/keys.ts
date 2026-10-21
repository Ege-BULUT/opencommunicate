/* End-to-end encryption in the app (core/src/e2e.ts): the account's key pair kept on this device, per chat
   repository and nick#id, and the account's password, asked for once to unlock the key from its backup (another
   device of the account made it) or to make that backup. A password typed to sign in or set in this session is
   used first, so it is not asked for twice. */
import type { Bus, Device } from "../../core/src/index.ts";
import { backUpKeys, setUpKeys, type Identity, type Keyring } from "../../core/src/e2e.ts";

const slot = (repo: string, id: string) => `oc.key.${repo}.${id}`;
export function storedKey(repo: string, id: string): Identity | null {
  try { return JSON.parse(localStorage.getItem(slot(repo, id)) ?? "null"); } catch { return null; }
}
function saveKey(repo: string, id: string, key: Identity) {
  try { localStorage.setItem(slot(repo, id), JSON.stringify(key)); } catch { /* private mode: asked again next time */ }
}

const typed = new Map<string, string>();
/** A password the person just typed for this account (signing in, setting it). */
export const rememberPassword = (repo: string, id: string, password: string) => typed.set(`${repo}/${id}`, password);

/** `again`: the last password given did not unlock the key. */
export type PasswordQuestion = (reason: "unlock" | "protect", again: boolean) => Promise<string | null>;
let ask: PasswordQuestion = async () => null;
/** The screen that asks for the password when the keys need it. */
export const answerPasswordQuestions = (f: PasswordQuestion) => { ask = f; };

/** This device's keys for a chat, unlocked or made as needed; null while the account's key stays locked here. */
export function keysFor(bus: Bus, repo: string, me: Device): Promise<Keyring | null> {
  let asked = 0, usedTyped = false;
  const who = `${repo}/${me.id}`;
  return setUpKeys(bus, me.id, {
    stored: storedKey(repo, me.id),
    save: (key) => saveKey(repo, me.id, key),
    password: async (reason) => {
      // the password just typed, once per setting up (forgotten when it worked: a second setting up, as React's
      // strict mode makes, still finds it)
      const t = typed.get(who);
      if (t && !usedTyped) { usedTyped = true; return t; }
      // an account with no password yet keeps its key on this device only; setting one backs it up
      if (reason === "protect" && !(await bus.passwordRecord(me.id))) return null;
      return ask(reason, reason === "unlock" && asked++ > 0);
    },
    members: (channel) => bus.membersOf(channel),
  }).then((k) => { if (k) typed.delete(who); return k; });
}

/** After the password is set or changed: the key's backup locked with the new one. */
export async function backUp(bus: Bus, repo: string, me: Device, password: string): Promise<void> {
  const key = storedKey(repo, me.id);
  if (key) await backUpKeys(bus, me.id, key, password);
}
