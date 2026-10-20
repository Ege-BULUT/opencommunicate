import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bus, ClaimError, DraftQueue, PALETTES, answerFor, answersTo, REACTIONS, isEditNotice, newerVersion, searchMessages, type Drafts, reactionKey, reactionsOn, type Reaction, type Reactions, chatRepoName, chatReposFirst, looksLikeChat, PASSWORD_MIN, Watcher, addressedTo, artDataUrl, dmChannel, dmPeer, groupAdmins, handle, isDm, msgPath, newestByChannel, pictureOf, verifyPassword, quietFor, recipientsOf, snippet, ticksFor, wantsNotice, type Device, type FileRef, type Group, type GroupChange, type Message, type PasswordRecord, type Presence, type Picture, type Pin, type Upload, type Quiet, type Receipt, type Receipts, type Ticks } from "../../core/src/index.ts";
import { notifyRecipients } from "../../core/src/notify.ts";
import { INVITE_BASE, acceptInvitation, canAdmit, createInvite, decodeInvite, encodeInvite, inviteMessage, post, processInvites, read, whatsappLink, type InviteCode } from "../../core/src/invite.ts";
import { Share } from "@capacitor/share";
import { App as NativeApp } from "@capacitor/app";
import { askNotifications, notify, openLink, saveFile } from "./platform.ts";
import { clearStored, describe, fetchFile, isLocal, kindOf, mediaModes, mimeOf, objectUrl, remember, setMediaMode, shrinkPhoto, storedSize, type MediaKind, type MediaMode } from "./media.ts";
import { LANGS, LOCALE, S, lang, setLang, type Lang } from "./i18n.tsx";
import { accountProblem, canSignIn, checkAccount, claim, clearChats, clearSignIn, credKey, currentToken, dropCred, renewCred, loadChats, pruneCreds, putCred, readStored, takeAuth, saveChats, sourceFor, tokenFor, withChat, withoutChat, type Chats, type Cred, desktopApp, finishSignIn, githubLogin, hosted, join, listRepos, native, readSignIn, repoExists, saveSession, saveSignIn, setPassword, startSignIn, type DeviceCode, type Session } from "./session.ts";

const POLL_MS = 4000;
const PULL = 56; // how far (after damping) the chat list is pulled down before letting go refreshes it

/* Back: an open dialog, picture or (on a phone) chat adds a browser history entry, so the phone's back
   gesture, the browser's Back and a mouse's back button close it instead of doing nothing or leaving. */
function useBack(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const id = Math.random().toString(36).slice(2);
    history.pushState({ ocBack: id }, "");
    let popped = false;
    const onPop = () => { if (history.state?.ocBack !== id) { popped = true; closeRef.current(); } };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!popped && history.state?.ocBack === id) history.back(); // closed on screen: drop our entry
    };
  }, [open]);
}
// Android: the WebView doesn't count pushState entries in canGoBack, so go by our own entry; with nothing
// left to close, back puts the app in the background, as other chat apps do
// (a reloaded page would otherwise leave the old page's listener behind, and each press would count twice)
if (native()) {
  const listener = NativeApp.addListener("backButton", () => { if (history.state?.ocBack) history.back(); else NativeApp.minimizeApp(); });
  window.addEventListener("pagehide", () => { listener.then((l) => l.remove()); });
}

function useNarrow() {
  const q = useMemo(() => matchMedia("(max-width: 760px)"), []);
  const [narrow, setNarrow] = useState(q.matches);
  useEffect(() => { const on = () => setNarrow(q.matches); q.addEventListener("change", on); return () => q.removeEventListener("change", on); }, [q]);
  return narrow;
}

/** A dialog: a close button in its header, Escape and back close it, and its body scrolls on small screens. */
function Sheet({ title, className = "", onClose, children }: { title: string; className?: string; onClose: () => void; children: ReactNode }) {
  useBack(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog" onClick={onClose}>
      <div className={`card sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>{title}</h2><button className="icon close" aria-label={S.close} title={S.close} onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>
  );
}
const BusContext = createContext<Bus | null>(null);
const KIND = S.kind;
// Read receipts (blue ticks), on unless turned off in Settings. Off works as in WhatsApp: this device tells no one
// it read their messages and sees no one's blue ticks; delivered (two grey ticks) still goes both ways.
const RECEIPTS_KEY = "oc.readReceipts";
const readReceiptsOn = () => { try { return localStorage.getItem(RECEIPTS_KEY) !== "off"; } catch { return true; } };

/** What the address brought: an invitation (#invite=…) or a chat repo (?repo=…), on the web or through an
 *  Android link (opencommunicate://invite#invite=…, opencommunicate://join?repo=…). */
type Arrival = { invite: InviteCode | null; repo: string | null };
const arrivalFrom = (url: string): Arrival => ({ invite: decodeInvite(url), repo: decodeURIComponent(url.match(/[?&]repo=([^&#]+)/)?.[1] ?? "") || null });
const noArrival: Arrival = { invite: null, repo: null };

export default function App() {
  const [chats, setChats] = useState<Chats | null | undefined>(undefined);
  const [arrival, setArrival] = useState<Arrival>(() => arrivalFrom(location.href));
  const [adding, setAdding] = useState(false); // joining another chat, with the GitHub account already signed in
  useEffect(() => { loadChats().then(setChats).catch(() => setChats(null)); }, []);
  // another tab changed the chats or the tokens: take them, so this tab never writes an old copy back over them
  // (and a sign-out there signs this tab out too); this tab keeps its own open chat
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "oc.auth" || e.key === null) takeAuth(e.newValue);
      if (e.key !== "oc.chats" && e.key !== null) return;
      const c = e.newValue ? readStored() : null;
      setChats((cur) => (c && cur?.active && c.chats.some((x) => x.repo === cur.active) ? { ...c, active: cur.active } : c));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  useEffect(() => {
    if (!native()) return;
    NativeApp.getLaunchUrl().then((u) => { if (u?.url) setArrival(arrivalFrom(u.url)); });
    const l = NativeApp.addListener("appUrlOpen", ({ url }) => setArrival(arrivalFrom(url)));
    return () => { l.then((h) => h.remove()); };
  }, []);
  const activity = useActivity(chats);
  if (chats === undefined) return <div className="center muted">{S.opening}</div>;
  const session = chats?.chats.find((c) => c.repo === chats.active) ?? chats?.chats[0] ?? null;
  const commit = (next: Chats) => { saveChats(next); setChats(next); };
  const update = (s: Session) => commit(withChat(chats ?? null, s));
  const open = (repo: string) => { if (chats) commit({ ...chats, active: repo }); };
  const forget = () => { setArrival(noArrival); if (location.hash.includes("invite=")) history.replaceState(null, "", location.pathname + location.search); };
  const joined = (s: Session) => { forget(); setAdding(false); commit(withChat(chats ?? null, s, true)); };
  const others = chats?.chats.length ?? 0;
  // the account this device signed in with; the repository's device record can name another
  const known = session ? { session, login: (session.account && !session.account.startsWith("repo:") ? session.account : session.device.login) ?? "" } : undefined;
  if (!session || adding) return <Onboarding arrival={arrival} known={known} onCancel={session ? () => { forget(); setAdding(false); } : undefined} onDone={joined} />;
  // an invitation to a chat this device is not in yet: join it as well (the other chats stay)
  if (arrival.invite) {
    const there = chats!.chats.find((c) => c.repo.toLowerCase() === arrival.invite!.r.toLowerCase());
    if (there) { if (there.repo !== session.repo) open(there.repo); forget(); }
    else return (
      <div className="center"><div className="card">
        <h1 className="brand">{S.invitation}</h1>
        <p>{S.invitedTo(arrival.invite.n, arrival.invite.r.split("/")[1])}</p>
        <p className="muted small">{S.inviteKeeps(others)}</p>
        <div className="actions start">
          {session.source === "app" && canSignIn() && <button className="primary" onClick={() => setAdding(true)}>{S.joinInvite}</button>}
          <button className="ghost" onClick={forget}>{S.cancel}</button>
        </div>
      </div></div>
    );
  }
  // a new token (signed in again, or another account) or another chat starts the chat view afresh
  // (a renewed token keeps the view: only signing in again changes session.token)
  return <Chat key={`${session.repo}/${credKey(session)}/${session.token}`} session={session} onSession={update} chats={chats!.chats} activity={activity}
    onOpen={open} onAdd={session.source === "app" && canSignIn() ? () => setAdding(true) : undefined}
    onSignOut={() => { const next = withoutChat(chats!, session.repo); if (next.chats.length) { commit(next); pruneCreds(next); } else { clearChats(); setChats(null); } }} />;
}

/**
 * New activity in the chats that are not open: each one's branch head, checked once a minute with its ETag (a 304
 * while nothing moved is free), against the head its chat view last saw (stored as "oc.head.<repo>").
 */
function useActivity(chats: Chats | null | undefined): Record<string, boolean> {
  const [moved, setMoved] = useState<Record<string, boolean>>({});
  const buses = useRef(new Map<string, Bus>());
  const heads = useRef(new Map<string, string>()); // the last head each bus saw (headIfChanged answers null while it stays)
  const list = chats?.chats ?? [];
  const key = list.map((c) => `${c.repo}/${credKey(c)}`).join(" ") + " " + (chats?.active ?? "");
  useEffect(() => {
    if (list.length < 2) { setMoved({}); return; }
    let stop = false;
    const check = async () => {
      const next: Record<string, boolean> = {};
      for (const c of list) {
        if (c.repo === chats?.active) continue;
        const id = `${c.repo}/${credKey(c)}`;
        if (!buses.current.has(id)) buses.current.set(id, new Bus({ repo: c.repo, token: sourceFor(c) }));
        try {
          const head = (await buses.current.get(id)!.headIfChanged()) ?? heads.current.get(id);
          if (head) heads.current.set(id, head);
          let seen: string | null = null; try { seen = localStorage.getItem(`oc.head.${c.repo}`); } catch { /* none */ }
          next[c.repo] = !!head && !!seen && head !== seen;
        } catch { /* offline: next minute */ }
      }
      if (!stop) setMoved(next);
    };
    check();
    const t = setInterval(check, 60_000);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return moved;
}

const SITE = "https://opencommunicate.vercel.app/";
const NTFY_IOS = "https://apps.apple.com/app/ntfy/id1625396347";
const platform = () => {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1)) return "ios";
  return /Android/.test(ua) ? "android" : "desktop";
};

/** After joining on the web: install the app for this device, or keep this page on the home screen. */
function NextSteps({ session, onContinue }: { session: Session; onContinue: () => void }) {
  const p = platform();
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone;
  return (
    <div className="center"><div className="card">
      <div className="card-head"><h1 className="brand">{S.ready}</h1><LangPicker /></div>
      <p>{S.joinedAs(handle(session.device), session.repo.split("/")[1])}</p>
      {p === "ios" && !standalone && (
        <ol className="steps">
          <li>{S.iosStep1}</li>
          <li>{S.iosStep2(handle(session.device))}</li>
          <li>{S.iosStep3(NTFY_IOS)}</li>
        </ol>
      )}
      {p === "android" && (
        <ol className="steps">
          <li>{S.androidStep1(SITE)}</li>
          <li>{S.androidStep2(`opencommunicate://join?repo=${encodeURIComponent(session.repo)}`, handle(session.device))}</li>
        </ol>
      )}
      {p === "desktop" && <p>{S.desktopNext(SITE)}</p>}
      <button className="primary" onClick={onContinue}>{p === "ios" && !standalone ? S.browserForNow : S.toChat}</button>
    </div></div>
  );
}

/** Phone app: an invitation link copied from a message, for when the link opened the browser instead. */
function PasteInvite({ onInvite }: { onInvite: (c: InviteCode) => void }) {
  const [text, setText] = useState("");
  const code = decodeInvite(text);
  return (
    <details className="paste">
      <summary>{S.haveInvite}</summary>
      <input value={text} placeholder={S.pasteInvite} onChange={(e) => setText(e.target.value)} />
      {text && !code && <p className="error small">{S.notInvite}</p>}
      {code && <button className="ghost" onClick={() => onInvite(code)}>{S.continueInvite(code.n)}</button>}
    </details>
  );
}

/** Invite someone: a one-time link, sent by WhatsApp, copied or shared. */
function InviteDialog({ bus, me, admin, onClose }: { bus: Bus; me: Device; admin: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const message = async () => {
    let l = link;
    if (!l) { l = (await createInvite(bus, me, { name: name.trim() || undefined, base: INVITE_BASE })).link; setLink(l); }
    return inviteMessage(l, handle(me), bus.repo, name.trim() || undefined, lang);
  };
  const run = (f: (text: string) => Promise<void> | void) => async () => {
    setBusy(true); setError(""); setDone("");
    try { await f(await message()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Sheet title={S.inviteSomeone} onClose={onClose}>
      <p className="small">{S.inviteIntro}</p>
      {!admin && <p className="muted small">{S.inviteNotAdmin}</p>}
      <label>{S.nameOptional}<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder={S.namePlaceholder} /></label>
      <label>{S.phone}<input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={S.phonePlaceholder} /></label>
      <div className="actions start">
        <button className="primary" disabled={busy || phone.replace(/\D/g, "").length < 10} onClick={run((t) => openLink(whatsappLink(phone, t)))}>{S.sendWhatsApp}</button>
        <button className="ghost" disabled={busy} onClick={run(async (t) => { await navigator.clipboard.writeText(t); setDone(S.messageCopied); })}>{S.copyMessage}</button>
        {(native() || "share" in navigator) && <button className="ghost" disabled={busy} onClick={run(async (t) => { if (native()) await Share.share({ text: t }); else await navigator.share({ text: t }); })}>{S.share}</button>}
      </div>
      {link && <p className="muted small">{S.linkCreated}</p>}
      {done && <p className="small">{done}</p>}
      {error && <p className="error small">{error}</p>}
    </Sheet>
  );
}

/** The language menu: Settings, and the top of the sign-in screens so it can be changed before signing in. */
function LangPicker() {
  return (
    <select className="lang-pick" aria-label={S.language} title={S.language} value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
      {Object.entries(LANGS).map(([k, name]) => <option key={k} value={k}>{name}</option>)}
    </select>
  );
}

/** Puts text on the clipboard; false when the browser refuses. The write starts inside the click while the
   text may still be on its way: Safari only allows clipboard writes during a click, not after an await. */
function copyText(text: string | Promise<string>): Promise<boolean> {
  const t = Promise.resolve(text);
  let write: Promise<void>;
  try { write = navigator.clipboard.write([new ClipboardItem({ "text/plain": t.then((x) => new Blob([x], { type: "text/plain" })) })]); }
  catch (e) { write = Promise.reject(e); }
  return write.catch(() => t.then((x) => navigator.clipboard.writeText(x))).then(() => true, () => false);
}

// GitHub device flow: copies the code, opens github.com/login/device, hands the token on
function GitHubSignIn({ label, primary = true, onToken }: { label: string; primary?: boolean; onToken: (cred: Cred) => Promise<void> }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const gone = useRef(false);
  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);
  const go = async () => {
    setError(""); setBusy(true);
    try {
      const started = startSignIn();
      const copying = copyText(started.then((c) => c.user_code));
      const c = await started;
      setCode(c);
      setCopied(await copying); // copied before GitHub's tab takes the focus a clipboard write needs
      openLink(c.verification_uri).catch(() => {}); // the code and the "GitHub'ı aç" link stay on screen if no tab opens
      const token = await finishSignIn(c, () => gone.current);
      setCode(null);
      await onToken(token);
    } catch (e) { if (!gone.current) setError((e as Error).message); }
    finally { if (!gone.current) { setBusy(false); setCode(null); } }
  };
  if (code) return (
    <div className="code">
      <p>{S.enterCode(copied)}</p>
      <button type="button" className="usercode" title={S.copy} onClick={async () => setCopied(await copyText(code.user_code))}>{code.user_code}</button>
      <p className="muted small" aria-live="polite">{copied ? S.codeCopied : S.tapToCopy}</p>
      {/* a real link: a browser opens it on the click itself, where a window.open after an await is a blocked popup */}
      <a className="ghost" href={code.verification_uri} target="_blank" rel="noopener"
        onClick={native() ? (e) => { e.preventDefault(); openLink(code.verification_uri).catch(() => {}); } : undefined}>{S.openGitHub}</a>
      <p className="muted small">{S.afterApprove}</p>
    </div>
  );
  return <>
    <button className={primary ? "primary" : "ghost"} disabled={busy} onClick={go}>{busy ? S.waiting : label}</button>
    {error && <p className="error">{error}</p>}
  </>;
}

/** A new password twice, and the current one first when `current` is a record; `onSave` stores the new one. */
function PasswordForm({ current, username, label, onSave }: { current?: PasswordRecord | null; username: string; label: string; onSave: (password: string) => Promise<void> }) {
  const [old, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const save = async () => {
    setBusy(true); setError(""); setDone(false);
    try {
      if (current && !(await verifyPassword(old, current))) throw new Error(S.wrongCurrent);
      await onSave(pw);
      setOld(""); setPw(""); setAgain(""); setDone(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  // a form with the account in a hidden username field, so the browser's password manager offers to save both
  return <form className="contents" onSubmit={(e) => { e.preventDefault(); save(); }}>
    <input hidden readOnly name="username" autoComplete="username" value={username} />
    {current && <label>{S.currentPassword}<input type="password" autoComplete="current-password" value={old} onChange={(e) => setOld(e.target.value)} /></label>}
    <label>{current ? S.newPassword : S.password}<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
    <label>{current ? S.newPasswordAgain : S.passwordAgain}<input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
    {pw && pw.length < PASSWORD_MIN && <p className="muted small">{S.minChars(PASSWORD_MIN)}</p>}
    {again && again !== pw && <p className="error small">{S.mismatch}</p>}
    <div className="actions start">
      <button type="submit" className="primary" disabled={busy || pw.length < PASSWORD_MIN || pw !== again || (!!current && !old)}>{busy ? S.saving : label}</button>
    </div>
    {done && <p className="small">{S.passwordSaved}</p>}
    {error && <p className="error small">{error}</p>}
  </form>;
}

/** A failed claim in words; wrong handle and wrong password read the same. */
function claimProblem(e: unknown, repo: string): string {
  if (e instanceof ClaimError) return e.reason === "format" ? S.claimFormat
    : e.reason === "login" ? S.claimNoPassword
    : S.claimWrong;
  return accountProblem(e, repo) ?? (e as Error).message;
}

const NEW_REPO = "+new"; // the "create a chat repository" choice; no "owner/name" looks like it

/** The repository list in two groups, with a repository from a link at the top even when the list lacks it. */
function repoGroups(repos: string[], picked: string): [string, string[]][] {
  const all = picked && picked !== NEW_REPO && !repos.some((r) => r.toLowerCase() === picked.toLowerCase()) ? [picked, ...repos] : repos;
  return [[S.chatRepos, all.filter(looksLikeChat)], [S.otherRepos, all.filter((r) => !looksLikeChat(r))]];
}

// ---------------- sign-in + join (phone) ----------------
/** Sign in with GitHub and join a chat; `known` is the GitHub account of a chat this device is already in, so
 *  adding another chat skips the sign-in, and `onCancel` goes back to the chats. */
function Onboarding({ arrival, known, onCancel, onDone }: { arrival: Arrival; known?: { session: Session; login: string }; onCancel?: () => void; onDone: (s: Session) => void }) {
  const invite = arrival.invite;
  const [pending] = useState(readSignIn); // approved on GitHub before the tab closed
  const [resumed] = useState(() => pending ?? (known ? { token: currentToken(known.session), login: known.login } : null)); // or already signed in
  const [token, setToken] = useState(resumed?.token ?? "");
  const [login, setLogin] = useState(resumed?.login ?? "");
  const [repo, setRepo] = useState(invite?.r ?? arrival.repo ?? "");
  const [repos, setRepos] = useState<string[] | null>(null); // the account's repositories, chat-looking ones first
  const [reposFailed, setReposFailed] = useState(false);
  const [newName, setNewName] = useState("opencommunicate");
  const [taken, setTaken] = useState<string[]>([]); // new names GitHub said already exist
  const [nick, setNick] = useState(resumed?.login.toLowerCase().slice(0, 12) ?? "");
  // an invited person is new to the chat, so "Yeni hesap" comes first for them; everyone else most likely returns
  const [mode, setMode] = useState<"have" | "new">(invite ? "new" : "have");
  const [account, setAccount] = useState("");
  const [password, setPasswordText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"signin" | "admit" | "join" | "password" | "next">(!resumed ? "signin" : resumed.joined ? "password" : invite ? "admit" : "join");
  const [note, setNote] = useState("");
  const [joined, setJoined] = useState<Session | null>(resumed?.joined ?? null);

  // a kept token that GitHub no longer accepts (revoked, and not renewable) means signing in again; a passing
  // problem (offline, an outage) keeps it. What uses the token waits for this check, so it gets the renewed one.
  const [checked, setChecked] = useState(!resumed);
  useEffect(() => {
    if (resumed) (async () => {
      // the account's stored token (renewed first if it ran out), for a sign-in in progress as for a known chat
      const s: Session = pending ? { repo: "", token: pending.token, device: { login: pending.login } as Device, source: "app", account: pending.login } : known!.session;
      let t = await tokenFor(s);
      let l = await githubLogin(t);
      // a 401: renewed as a chat's Bus would (refresh token, then other chats' old tokens) before asking to sign in
      if (!l) { const n = await renewCred(credKey(s), t); if (n) { t = n; l = await githubLogin(n); } }
      if (t !== resumed.token) setToken(t);
      if (!l) { clearSignIn(); setToken(""); setJoined(null); setStage("signin"); }
      else { setLogin(l); setNick((x) => x || l.toLowerCase().slice(0, 12)); } // GitHub's word on the account
    })().catch(() => {}).finally(() => setChecked(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the repositories to choose from; a likely chat first, or a new one when none looks like a chat
  useEffect(() => {
    if (!checked || stage !== "join" || invite || !token || repos) return;
    listRepos(token).then(
      (names) => { const list = chatReposFirst(names); setRepos(list); setRepo((r) => r || (list.find(looksLikeChat) ?? NEW_REPO)); },
      () => { setReposFailed(true); setRepo((r) => r || `${login}/opencommunicate-chat`); },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, token, checked]);

  // invited: ask to be let in, then wait for an admin's app to add us and accept GitHub's invitation
  useEffect(() => {
    if (!checked || stage !== "admit" || !invite) return;
    let stop = false;
    (async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      let claimed = 0;
      const started = Date.now();
      while (!stop) {
        try {
          if (await acceptInvitation(token, invite.r)) { if (!stop) setStage("join"); return; }
          if (Date.now() - claimed > 60_000) { await post(invite.t, { kind: "claim", id: invite.i, secret: invite.s, login }); claimed = Date.now(); }
          const refused = (await read(invite.t, since)).find((n) => n.kind === "refused" && n.login === login);
          if (refused?.kind === "refused") { setError(refused.why ? S.refused(refused.why, login, refused.status) : refused.reason); return; }
          setNote(Date.now() - started < 20_000 ? S.admitting : S.admitWait(invite.n));
        } catch (e) { setNote(S.retrying((e as Error).message)); }
        await new Promise((r) => setTimeout(r, 4000));
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, token, checked]);

  if (!canSignIn() && !token) {
    return (
      <div className="center"><div className="card">
        <div className="card-head"><h1 className="brand">OpenCommunicate</h1><LangPicker /></div>
        <p>{S.cliOpen}</p>
        <pre>opencom ui</pre>
        <p className="muted">{S.firstSetup} <code>opencom init {S.cliArgs}</code></p>
      </div></div>
    );
  }

  const signedIn = async (cred: Cred) => {
    const t = cred.token;
    const l = await githubLogin(t);
    if (!l) throw new Error(S.signInFailed);
    putCred(l, cred); // the account's token (and refresh token) for every chat it signs in to
    saveSignIn({ token: t, login: l });
    setToken(t); setLogin(l); setNick(l.toLowerCase().slice(0, 12));
    setStage(invite ? "admit" : "join");
  };

  const finish = (s: Session) => {
    saveSession(s); clearSignIn(); // signed in from here on, even if this tab closes before the next screen
    // on the web the next step depends on the device: install the app, or add this page to the home screen
    if (hosted() && !known) {
      history.replaceState(null, "", `${location.pathname}?repo=${encodeURIComponent(s.repo)}`);
      setJoined(s); setStage("next");
    } else onDone(s);
  };

  const creating = !invite && repo === NEW_REPO;
  const newRepo = `${login}/${chatRepoName(newName)}`;
  const nameTaken = creating && [...(repos ?? []), ...taken].some((r) => r.toLowerCase() === newRepo.toLowerCase());
  const awaitPassword = (s: Session) => { saveSignIn({ token, login, joined: s }); setJoined(s); setStage("password"); };
  // a way out of every step: pick another chat or nickname, or start over with another GitHub account
  const back = () => { saveSignIn({ token, login }); setJoined(null); setError(""); setStage("join"); };
  const otherAccount = () => { if (login && credKey(known?.session ?? { repo: "", device: {} as Device }) !== login.toLowerCase()) dropCred(login); clearSignIn(); setToken(""); setLogin(""); setJoined(null); setRepos(null); setReposFailed(false); setError(""); setStage("signin"); };

  const doJoin = async () => {
    setError(""); setBusy(true);
    try {
      // the list can miss a repository (one it couldn't page to): GitHub has the last word on a new name
      if (creating && await repoExists(token, newRepo)) { setTaken((t) => [...t, newRepo]); return; }
      awaitPassword(await join(token, creating ? newRepo : repo.trim(), nick.trim()));
    }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const doClaim = async () => {
    setError(""); setBusy(true);
    try {
      const { session: s, needsPassword } = await claim(token, repo.trim(), account, password);
      if (needsPassword) awaitPassword(s); else finish(s);
    }
    catch (e) { setError(claimProblem(e, repo.trim())); }
    finally { setBusy(false); }
  };

  if (stage === "next" && joined) return <NextSteps session={joined} onContinue={() => onDone(joined)} />;

  return (
    <div className="center"><div className="card">
      <div className="card-head"><h1 className="brand">OpenCommunicate</h1><LangPicker /></div>
      {invite && <p className="invite-note">{S.invitedTo(invite.n, invite.r.split("/")[1])}</p>}
      {stage === "signin" && (
        <>
          <p>{S.intro(!!invite)}</p>
          <GitHubSignIn label={S.signInGitHub} onToken={signedIn} />
          {invite && <p className="muted small">{S.noGitHub}</p>}
          {!invite && native() && <PasteInvite onInvite={(c) => { setRepo(c.r); location.hash = `invite=${encodeInvite(c)}`; location.reload(); }} />}
        </>
      )}
      {stage === "admit" && (
        <>
          <p>{S.signedInAs(login)}</p>
          {!error && <p className="muted"><span className="spinner" aria-hidden="true" /> {note || S.admitting}</p>}
          <div className="actions start"><button className="ghost" onClick={otherAccount}>{S.signInOther}</button></div>
        </>
      )}
      {stage === "join" && (
        <>
          <p>{S.signedInAs(login)} {invite ? S.addedToChat : S.whichChat}</p>
          {!invite && (reposFailed
            ? <label>{S.chatRepo}<input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={S.ownerRepo} /></label>
            : <label>{S.chatRepo}
                <select value={repos ? repo : ""} disabled={!repos} onChange={(e) => { setRepo(e.target.value); setError(""); }}>
                  {!repos ? <option value="">{S.loadingRepos}</option> : <>
                    <option value={NEW_REPO}>{S.newChatRepo}</option>
                    {repoGroups(repos, repo).map(([title, names]) => names.length > 0 && (
                      <optgroup key={title} label={title}>{names.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>
                    ))}
                  </>}
                </select>
              </label>)}
          {creating && <>
            <label>{S.newRepoName}<input value={newName} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => { setNewName(e.target.value); setError(""); }} /></label>
            {nameTaken
              ? <p className="error small">{S.repoTaken(newRepo)}</p>
              : <p className="muted small">{S.repoPreview(newRepo)}</p>}
          </>}
          {/* a new repository has no accounts yet, so there is only "Yeni hesap" */}
          {!creating && <div className="actions start" role="radiogroup" aria-label={S.account}>
            <button role="radio" aria-checked={mode === "have"} className={mode === "have" ? "primary" : "ghost"} onClick={() => { setMode("have"); setError(""); }}>{S.haveAccount}</button>
            <button role="radio" aria-checked={mode === "new"} className={mode === "new" ? "primary" : "ghost"} onClick={() => { setMode("new"); setError(""); }}>{S.newAccount}</button>
          </div>}
          {mode === "have" && !creating ? (
            // a real form with username/password fields, so the browser's password manager fills and saves the account
            <form className="contents" onSubmit={(e) => { e.preventDefault(); doClaim(); }}>
              <label>{S.accountField}<input name="username" autoComplete="username" value={account} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={S.accountPlaceholder} onChange={(e) => setAccount(e.target.value)} /></label>
              <label>{S.password}<input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPasswordText(e.target.value)} /></label>
              <button type="submit" className="primary" disabled={busy || !repo.includes("/") || !account.includes("#")}>{busy ? S.connecting : S.signIn}</button>
            </form>
          ) : <>
            <label>{S.nickname}<input value={nick} maxLength={24} onChange={(e) => setNick(e.target.value)} /></label>
            <p className="muted">{S.handleNote}</p>
            <button className="primary" disabled={busy || !nick.trim() || (creating ? !newName.trim() || nameTaken : !repo.includes("/"))} onClick={doJoin}>{busy ? S.connecting : creating ? S.createAndJoin : S.join}</button>
          </>}
          <div className="actions start"><button className="ghost" disabled={busy} onClick={otherAccount}>{S.signInOther}</button></div>
        </>
      )}
      {stage === "password" && joined && (
        <>
          <p>{S.yourAccount(handle(joined.device))}</p>
          <PasswordForm username={handle(joined.device)} label={S.savePassword} onSave={async (pw) => { await setPassword(joined, pw); finish(joined); }} />
          <div className="actions start">
            {!invite && <button className="ghost" onClick={back}>{S.back}</button>}
            <button className="ghost" onClick={otherAccount}>{S.signInOther}</button>
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {onCancel && <div className="actions start"><button className="ghost" onClick={onCancel}>{S.backToChats}</button></div>}
    </div></div>
  );
}

// ---------------- chat ----------------
type Pending = Message & { pending?: boolean; failed?: boolean };

function Chat({ session, onSession, onSignOut, chats, activity, onOpen, onAdd }: { session: Session; onSession: (s: Session) => void; onSignOut: () => void; chats: Session[]; activity: Record<string, boolean>; onOpen: (repo: string) => void; onAdd?: () => void }) {
  // the bus and the watcher follow the chat and the token; a change to this device (picture, notifications) keeps them
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bus = useMemo(() => new Bus({ repo: session.repo, token: sourceFor(session) }), [session.repo, credKey(session), session.source]);
  const [me, setMe] = useState<Device>(session.device);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const watcher = useMemo(() => new Watcher(bus, session.device), [bus, session.device.id]);
  const READ_KEY = `oc.read.${session.repo}`; // read markers per chat: channel names ("all") repeat across chats
  const seenHead = () => { try { if (watcher.head) localStorage.setItem(`oc.head.${session.repo}`, watcher.head); } catch { /* private mode */ } };
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [messages, setMessages] = useState<Record<string, Pending[]>>({});
  const [active, setActive] = useState("all");
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [dialog, setDialog] = useState<"group" | "settings" | "channel" | "invite" | "chats" | null>(null);
  const [admin, setAdmin] = useState(false);
  const [toast, setToast] = useState("");
  const [status, setStatus] = useState(S.loading);
  const [account, setAccount] = useState<string | null>(null); // a GitHub problem only the person can fix
  const [read, setRead] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(READ_KEY) ?? "{}"); } catch { return {}; } });
  const [receipts, setReceipts] = useState<Receipts>({});
  const [pins, setPins] = useState<Pin[]>([]); // this account's pinned messages (shared by every device signed in as it), newest first
  const [reactions, setReactions] = useState<Reactions>({});
  // what this account typed and has not sent, per chat; mirrored in localStorage so it shows before GitHub answers
  const DRAFTS_KEY = `oc.drafts.${session.repo}.${session.device.id}`;
  const [drafts, setDrafts] = useState<Drafts>(() => { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}"); } catch { return {}; } });
  useEffect(() => { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* private mode */ } }, [drafts, DRAFTS_KEY]);
  const draftQueue = useMemo(() => new DraftQueue(bus, () => meRef.current), [bus]);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDrafts = useCallback(() => {
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    draftQueue.flush();
  }, [draftQueue]);
  const saveDraft = (ch: string, text: string) => {
    setDrafts((d) => { const n = { ...d }; if (text.trim()) n[ch] = { text, at: new Date().toISOString() }; else delete n[ch]; return n; });
    draftQueue.set(ch, text);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(flushDrafts, 1500);
  };
  // a draft from another device of this account, except where something typed here is still on its way
  const takeDrafts = (remote: Drafts, since: number) => setDrafts((local) => draftQueue.merge(local, remote, since));
  useEffect(() => {
    const away = () => { if (document.hidden) flushDrafts(); };
    document.addEventListener("visibilitychange", away);
    window.addEventListener("pagehide", flushDrafts);
    return () => { document.removeEventListener("visibilitychange", away); window.removeEventListener("pagehide", flushDrafts); flushDrafts(); };
  }, [flushDrafts]);
  const [showRead, setShowRead] = useState(readReceiptsOn);
  const showReadRef = useRef(showRead);
  showReadRef.current = showRead;
  // receipts wait a moment and go out together: one commit for a burst of messages, not one per message
  const queued = useRef<Record<string, Receipt>>({});
  const flushAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const told = useRef<Record<string, Receipt>>({}); // what this session already sent: skip the round trip for it again
  const queueReceipts = useCallback((update: Record<string, Receipt>) => {
    let any = false;
    for (const [ch, r] of Object.entries(update)) {
      const was = told.current[ch] ?? {};
      const fresh: Receipt = {};
      if (r.delivered && !(was.delivered && was.delivered >= r.delivered)) fresh.delivered = r.delivered;
      if (r.read && !(was.read && was.read >= r.read)) fresh.read = r.read;
      if (!fresh.delivered && !fresh.read) continue;
      told.current[ch] = { ...was, ...fresh };
      queued.current[ch] = { ...queued.current[ch], ...fresh };
      any = true;
    }
    if (!any || flushAt.current) return;
    flushAt.current = setTimeout(() => {
      flushAt.current = null;
      const batch = queued.current;
      queued.current = {};
      // a failed write is forgotten, so the next message or visit sends it again
      bus.markReceipts(meRef.current, batch).catch(() => { for (const ch of Object.keys(batch)) delete told.current[ch]; });
    }, 2500);
  }, [bus]);
  const delivered = useCallback((list: Message[]) => {
    const newest = newestByChannel(list.filter((m) => m.from !== session.device.id && !m.system));
    if (Object.keys(newest).length) queueReceipts(Object.fromEntries(Object.entries(newest).map(([ch, id]) => [ch, { delivered: id }])));
  }, [queueReceipts, session.device.id]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const meRef = useRef(me);
  const onSessionRef = useRef(onSession); onSessionRef.current = onSession; // the chat list as it is now, not at mount
  meRef.current = me;

  const replace = useCallback((m: Message) => setMessages((prev) => ({ ...prev, [m.channel]: (prev[m.channel] ?? []).map((x) => (x.id === m.id ? m : x)) })), []);
  const add = useCallback((list: Message[]) => {
    if (!list.length) return;
    setMessages((prev) => {
      const next = { ...prev };
      for (const m of list) {
        const cur = next[m.channel] ?? [];
        if (cur.some((x) => x.id === m.id && !x.pending)) continue;
        next[m.channel] = [...cur.filter((x) => x.id !== m.id), m].sort((a, b) => a.id.localeCompare(b.id));
      }
      return next;
    });
  }, []);

  // pull to refresh: the poll loop checks at once, and also scans the repository for anything GitHub's
  // compare view left out
  const [refreshing, setRefreshing] = useState(false);
  const [pull, setPull] = useState(0);
  const refreshRef = useRef(false);
  const wakeRef = useRef(() => {});
  const refresh = () => { refreshRef.current = true; setRefreshing(true); wakeRef.current(); setTimeout(() => setRefreshing(false), 15_000); };
  const refreshFn = useRef(refresh); refreshFn.current = refresh;
  const [navEl, setNavEl] = useState<HTMLElement | null>(null); // the chat list, once it is on screen
  useEffect(() => {
    const el = navEl;
    if (!el) return;
    let y0: number | null = null, d = 0;
    const start = (e: TouchEvent) => { y0 = el.scrollTop <= 0 ? e.touches[0].clientY : null; d = 0; };
    const move = (e: TouchEvent) => {
      if (y0 === null) return;
      d = Math.max(0, e.touches[0].clientY - y0) * 0.5;
      if (d > 0 && el.scrollTop <= 0) { setPull(Math.min(d, 80)); if (e.cancelable) e.preventDefault(); }
    };
    const end = () => { if (y0 !== null && d >= PULL) refreshFn.current(); y0 = null; d = 0; setPull(0); };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => { el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move); el.removeEventListener("touchend", end); el.removeEventListener("touchcancel", end); };
  }, [navEl]);

  // start: directory + recent history of every channel, then poll
  useEffect(() => {
    let stop = false;
    // coming back to the app (or a pull to refresh) checks at once instead of waiting out the interval
    let wake = () => {};
    wakeRef.current = () => wake();
    const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
    const onVisible = () => { if (!document.hidden) wake(); };
    document.addEventListener("visibilitychange", onVisible);
    (async () => {
      // a failed start is retried (the phone may be offline or just waking up); an account problem waits for sign-in
      for (let wait = POLL_MS; ; wait = Math.min(wait * 2, 60_000)) {
        if (stop) return;
        try {
          await bus.gh(`/repos/${session.repo}`); // a repository this account can't see would otherwise look empty
          await watcher.start();
          if (stop) return; // left this chat meanwhile: write nothing back
        setDevices(watcher.devices); setGroups(watcher.groups);
        // the repository's devices/<id>.json is the truth (another client may have changed it)
        const stored = watcher.devices.find((d) => d.id === session.device.id);
          if (stored) { setMe(stored); onSessionRef.current({ ...session, device: stored }); }
          else if (watcher.devices.length) { setStatus(S.removedDevice); return; }
          const hist = await bus.histories([...watcher.channels], 60, watcher.head ?? undefined);
          for (const list of Object.values(hist)) list.forEach((m) => watcher.seen.add(msgPath(m)));
          setMessages(hist);
          delivered(Object.values(hist).flat());
          watcher.tickReceipts().then(() => setReceipts(watcher.receipts)).catch(() => {});
          watcher.tickPins().then(() => setPins(watcher.pins)).catch(() => {});
          watcher.tickReactions().then(() => setReactions(watcher.reactions)).catch(() => {});
          const draftsAsked = Date.now();
          watcher.tickDrafts().then(() => takeDrafts(watcher.drafts, draftsAsked)).catch(() => {});
          setStatus(""); setAccount(null); seenHead();
          watcher.tickPresence().then(() => setPresence(watcher.presence)).catch(() => {});
          bus.heartbeat(session.device).catch(() => {});
          askNotifications();
          break;
        } catch (e) {
          const problem = accountProblem(e, session.repo);
          setAccount(problem);
          setStatus(problem ? "" : S.cantConnect((e as Error).message));
          await sleep(wait);
        }
      }
      let beat = Date.now();
      let failures = 0;
      while (!stop) {
        await sleep(POLL_MS);
        if (stop) break;
        const full = refreshRef.current;
        refreshRef.current = false;
        try {
          const fresh = await watcher.tick(full);
          seenHead();
          setDevices([...watcher.devices]); setGroups([...watcher.groups]);
          add(fresh);
          delivered(fresh);
          // an edit or delete notice: read the message it names again (its file changed in place)
          for (const n of fresh.filter(isEditNotice)) bus.message(n.channel, n.system!.target!).then((m) => { if (m) replace(m); }).catch(() => {});
          if (await watcher.tickReceipts().catch(() => false)) setReceipts(watcher.receipts);
          if (await watcher.tickPins().catch(() => false)) setPins(watcher.pins);
          if (await watcher.tickReactions().catch(() => false)) setReactions(watcher.reactions);
          const draftsAsked = Date.now();
          if (await watcher.tickDrafts().catch(() => false)) takeDrafts(watcher.drafts, draftsAsked);
          for (const m of fresh) {
            if (m.from === session.device.id || isEditNotice(m) || !wantsNotice(meRef.current, m)) continue;
            if (document.hidden || activeRef.current !== m.channel) notify(`${m.fromNick}#${m.from}`, m.text || S.fileNotice);
          }
          if (await watcher.tickPresence().catch(() => false)) setPresence(watcher.presence);
          if (Date.now() - beat > 5 * 60_000) { beat = Date.now(); bus.heartbeat(session.device).catch(() => {}); }
          failures = 0;
          setStatus(""); setAccount(null);
        } catch (e) {
          const problem = accountProblem(e, session.repo);
          if (problem) setAccount(problem);
          // phones drop a request now and then (network switch, app waking up); only a run of failures is news
          else if (++failures >= 3 || full) setStatus(S.connProblem((e as Error).message));
        }
        if (full) setRefreshing(false);
      }
    })();
    return () => { stop = true; wake(); document.removeEventListener("visibilitychange", onVisible); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watcher]);

  // a client whose account runs the repo lets invited people in (see core/src/invite.ts)
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!(await canAdmit(bus))) return;
      setAdmin(true);
      while (!stop) {
        try {
          for (const login of await processInvites(bus, meRef.current)) { setToast(S.joinedByInvite(login)); setTimeout(() => setToast(""), 8000); }
        } catch { /* next round */ }
        await new Promise((r) => setTimeout(r, 15_000));
      }
    })();
    return () => { stop = true; };
  }, [bus]);

  const markRead = useCallback((ch: string) => {
    const lastIn = messages[ch]?.filter((m) => !m.pending && !m.failed && m.from !== me.id && !m.system).at(-1)?.id;
    if (lastIn && showReadRef.current) queueReceipts({ [ch]: { read: lastIn } });
    const last = messages[ch]?.at(-1)?.id;
    if (!last || read[ch] === last) return;
    const next = { ...read, [ch]: last };
    setRead(next);
    localStorage.setItem(READ_KEY, JSON.stringify(next));
  }, [messages, read, me.id, queueReceipts]);
  useEffect(() => { if (!document.hidden) markRead(active); }, [active, messages, markRead]);
  useEffect(() => {
    const onVisible = () => { if (!document.hidden) markRead(activeRef.current); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [markRead]);

  const others = devices.filter((d) => d.id !== me.id).sort((a, b) => a.nick.localeCompare(b.nick));
  const myGroups = groups.filter((g) => g.members.includes(me.id));
  const activeGroup = myGroups.find((g) => g.channel === active);
  useEffect(() => { if (active.startsWith("g-") && groups.length && !activeGroup) { setActive("all"); setDialog((d) => (d === "channel" ? null : d)); } }, [active, activeGroup, groups.length]);
  const quiet = (ch: string) => quietFor(me, ch);
  const saveQuiet = async (ch: string, q: Quiet | null) => {
    const next: Device = { ...me, quiet: { ...me.quiet } };
    if (q) next.quiet![ch] = q; else delete next.quiet![ch];
    await bus.updateDevice(next);
    setMe(next);
    onSession({ ...session, device: next });
  };
  const changeGroup = async (g: Group, change: GroupChange) => {
    const next = await bus.changeGroup(g.channel, change, me, devices);
    setGroups((list) => list.map((x) => (x.channel === next.channel ? next : x)));
    await watcher.refresh();
  };
  const unread = (ch: string) => (messages[ch] ?? []).filter((m) => m.from !== me.id && !isEditNotice(m) && (!read[ch] || m.id > read[ch])).length;
  const online = (id: string) => !!presence[id] && Date.now() - Date.parse(presence[id].lastSeen) < 10 * 60_000;
  const [filter, setFilter] = useState("");
  const [reply, setReply] = useState<Message | null>(null);
  const [menu, setMenu] = useState<{ m: Message; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null); // non-null = selection mode
  const [forwarding, setForwarding] = useState<Message[] | null>(null); // messages waiting for a target chat
  const toggleSel = useCallback((id: string) => setSelected((s) => { const n = new Set(s ?? []); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const doForward = async (channel: string, msgs: Message[]) => {
    setForwarding(null); setSelected(null);
    try {
      const sent = await bus.forward(channel, me, msgs);
      if (channel === active) add(sent);
      for (const m of sent) notifyRecipients(m, me, devices, groups).catch(() => {});
      setToast(S.forwardedTo(sent.length, isDm(channel) ? "@" + handle(devices.find((d) => d.id === dmPeer(channel, me.id)) ?? { nick: "?", id: "" }) : "#" + (channel === "all" ? "all" : groups.find((g) => g.channel === channel)?.name ?? channel)));
      setTimeout(() => setToast(""), 5000);
    } catch (e) { setToast(S.cantForward((e as Error).message)); setTimeout(() => setToast(""), 6000); }
  };
  const byId = useCallback((id: string) => (messages[active] ?? []).find((m) => m.id === id), [messages, active]);
  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(`m-${id}`);
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1200); }
  }, []);
  // search: the loaded messages at once; older ones a page at a time, on request (each is a GitHub call)
  const [olderLeft, setOlderLeft] = useState<number | null>(null); // null until asked; 0 when everything is loaded
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = async () => {
    setLoadingOlder(true);
    try {
      const have = new Set(Object.values(messages).flat().filter((m) => !m.pending && !m.failed).map(msgPath));
      const { messages: older, left } = await bus.older([...watcher.channels], have, 300, watcher.head);
      older.forEach((m) => watcher.seen.add(msgPath(m)));
      add(older);
      setOlderLeft(left);
    } catch (e) { setToast(S.cantSearch((e as Error).message)); setTimeout(() => setToast(""), 6000); }
    finally { setLoadingOlder(false); }
  };
  const chatName = (ch: string) => ch === "all" ? "#all" : isDm(ch) ? handle(devices.find((d) => d.id === dmPeer(ch, me.id)) ?? { nick: "?", id: dmPeer(ch, me.id) }) : `#${groups.find((g) => g.channel === ch)?.name ?? ch}`;
  const query = filter.trim();
  const found = query.length >= 2 ? searchMessages(Object.values(messages).flat(), query, LOCALE) : [];
  const pinKey = (m: Pick<Pin, "channel" | "id">) => `${m.channel}/${m.id}`;
  const pinned = useMemo(() => new Set(pins.map(pinKey)), [pins]);
  // shown at once, then replaced by what the pins branch holds; a failed write puts the old list back
  const pin = async (msgs: Pick<Message, "channel" | "id">[], on: boolean) => {
    const before = pins;
    setPins(on ? [...msgs.filter((m) => !pinned.has(pinKey(m))).map((m) => ({ channel: m.channel, id: m.id, at: new Date().toISOString() })), ...pins] : pins.filter((p) => !msgs.some((m) => pinKey(m) === pinKey(p))));
    try { setPins(await bus.setPins(me, msgs, on)); }
    catch (e) { setPins(before); setToast(S.cantPin(on, (e as Error).message)); setTimeout(() => setToast(""), 6000); }
  };
  // shown at once; a failed write puts the old reactions back
  const react = async (m: Message, emoji: Reaction | null) => {
    const before = reactions;
    const mine = { ...reactions[me.id] };
    if (emoji) mine[reactionKey(m)] = emoji; else delete mine[reactionKey(m)];
    setReactions({ ...reactions, [me.id]: mine });
    try { await bus.react(me, m, emoji); }
    catch (e) { setReactions(before); setToast(S.cantReact((e as Error).message)); setTimeout(() => setToast(""), 6000); }
  };
  const myReaction = (m: Message) => reactions[me.id]?.[reactionKey(m)] ?? null;
  const last = (ch: string) => messages[ch]?.at(-1);
  const recent = (a: string, b: string) => (last(b)?.id ?? "").localeCompare(last(a)?.id ?? "");
  const shown = (label: string) => label.toLocaleLowerCase(LOCALE).includes(filter.trim().toLocaleLowerCase(LOCALE));
  const preview = (ch: string): ReactNode => {
    const draft = ch !== active || (narrow && mobileView === "list") ? drafts[ch]?.text : undefined;
    if (draft) return <><span className="draft-tag">{S.draft}</span> {draft}</>;
    const m = last(ch);
    if (!m) return "";
    const body = m.system ? systemText(m, devices) : m.deleted ? S.deletedMsg : m.text || (m.files?.length ? `📎 ${m.files[0].name}` : "");
    if (m.system) return body;
    if (m.from === me.id) return S.youSaid(body);
    return isDm(ch) ? body : `${m.fromNick}: ${body}`;
  };
  const seen = (id: string) => (online(id) ? S.online : presence[id] ? S.lastSeen(when(presence[id].lastSeen)) : "");
  const title = active === "all" ? "#all" : isDm(active) ? `@${handle(devices.find((d) => d.id === dmPeer(active, me.id)) ?? { nick: "?", id: dmPeer(active, me.id) })}` : `#${groups.find((g) => g.channel === active)?.name ?? active}`;

  const open = (ch: string) => { setActive(ch); setMobileView("chat"); };
  const narrow = useNarrow();
  useBack(narrow && mobileView === "chat", () => setMobileView("list"));
  const peer = isDm(active) ? devices.find((d) => d.id === dmPeer(active, me.id)) : undefined;
  const headAvatar = peer ? <Avatar name={peer.nick} seed={peer.id} shape={peer.kind === "agent" ? "agent" : "person"} online={online(peer.id)} size={36} picture={pictureOf(peer)} />
    : <Avatar name={activeGroup?.name ?? "all"} seed={activeGroup?.channel ?? "all"} shape="group" size={36} />;
  // what an online peer says it is doing: "online • deploying 0.8.5", sliding when it does not fit
  const doing = peer && online(peer.id) ? presence[peer.id]?.status : undefined;
  const headSub = peer ? (doing ? <>{S.online} • <Marquee text={doing} /></> : [KIND[peer.kind] ?? peer.kind, seen(peer.id)].filter(Boolean).join(" · "))
    : activeGroup ? S.members(activeGroup.members.length) : S.everyoneCount(devices.length);
  const loud = Object.keys(messages).filter((ch) => quietFor(me, ch)?.mode !== "off").reduce((n, ch) => n + unread(ch), 0);
  useEffect(() => { desktopApp()?.badge(loud); }, [loud]);

  // what a failed message needs to go again, by its draft id; kept in memory, so a reload drops it
  type SendOpts = { replyTo?: string; answer?: { choice: number | null } };
  const unsent = useRef<Record<string, { channel: string; text: string; payload: Upload[]; opts: SendOpts }>>({});
  const drop = (channel: string, id: string) => setMessages((prev) => ({ ...prev, [channel]: (prev[channel] ?? []).filter((x) => x.id !== id) }));
  const deliver = async (channel: string, text: string, payload: Upload[], opts: SendOpts = {}) => {
    const draft: Pending = { ...bus.newMessage(channel, me, text, opts), pending: true, files: payload.map(({ data, ...f }) => ({ ...f, path: "", size: data.length })) };
    add([draft]);
    try {
      const sent = await bus.send(channel, me, text, payload, opts);
      const modes = mediaModes();
      sent.files?.forEach((f, i) => { const k = kindOf(f); remember(f.path, payload[i].data, !!k && modes[k] === "save"); });
      watcher.seen.add(msgPath(sent));
      setMessages((prev) => ({ ...prev, [channel]: [...(prev[channel] ?? []).filter((x) => x.id !== draft.id), sent].sort((a, b) => a.id.localeCompare(b.id)) }));
      notifyRecipients(sent, me, devices, groups).catch(() => {});
      setStatus((s) => (s.startsWith(S.cantSend("")) ? "" : s));
    } catch (e) {
      unsent.current[draft.id] = { channel, text, payload, opts };
      setMessages((prev) => ({ ...prev, [channel]: (prev[channel] ?? []).map((x) => (x.id === draft.id ? { ...x, pending: false, failed: true } : x)) }));
      const problem = accountProblem(e, session.repo);
      if (problem) setAccount(problem); else setStatus(S.cantSend((e as Error).message));
    }
  };
  const send = async (text: string, files: File[]) => {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()), ...(await describe(f)) })));
    const q = reply;
    setReply(null);
    saveDraft(active, "");
    // a reply to an ask answers it: with the choice its text is, or as a written answer
    await deliver(active, text, payload, q ? { replyTo: q.id, ...(q.ask && !q.deleted ? { answer: answerFor(q, text) } : {}) } : {});
  };
  /** Picks choice `i` of an ask, or with null starts a written answer (a reply to it). */
  const answer = (m: Message, i: number | null) => {
    if (i === null) { setReply(m); return; }
    return deliver(m.channel, m.ask![i], [], { replyTo: m.id, answer: { choice: i } });
  };
  /** A failed message goes again as a new one (new time, at the end of the chat); discard forgets it. */
  const resend = (m: Message) => {
    const u = unsent.current[m.id];
    if (!u) return;
    delete unsent.current[m.id];
    drop(u.channel, m.id);
    return deliver(u.channel, u.text, u.payload, u.opts);
  };
  const [editing, setEditing] = useState<Message | null>(null);
  useEffect(() => { setEditing(null); flushDrafts(); }, [active, flushDrafts]);
  const amend = async (m: Message, text: string | null) => {
    try {
      const { message, notice } = await bus.amend(me, m, text);
      watcher.seen.add(msgPath(notice));
      replace(message); add([notice]);
    } catch (e) { setToast(S.cantAmend(text === null, (e as Error).message)); setTimeout(() => setToast(""), 6000); }
  };
  const discard = (m: Message) => { delete unsent.current[m.id]; drop(m.channel, m.id); };
  const resendRef = useRef(resend);
  resendRef.current = resend;
  // back online: whatever failed goes again by itself, oldest first, as WhatsApp does
  useEffect(() => {
    const again = () => {
      for (const list of Object.values(messagesRef.current)) for (const m of list) if (m.failed && unsent.current[m.id]) resendRef.current(m);
    };
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, []);

  return (
    <BusContext.Provider value={bus}>
    <div className={`layout view-${mobileView}`}>
      <aside className="sidebar">
        <header className="side-head">
          <span className="brand">OpenCommunicate</span>
          <span className="head-buttons">
            <button className="icon" title={S.inviteSomeone} aria-label={S.inviteSomeone} onClick={() => setDialog("invite")}><PersonPlus /></button>
            <button className="icon" title={S.settings} aria-label={S.settings} onClick={() => setDialog("settings")}><Gear /></button>
          </span>
        </header>
        <UpdateBanner />
        {account && <AccountAlert text={account} onFix={() => setDialog("settings")} />}
        <button className="me" onClick={() => setDialog("chats")} title={S.chatsTitle} aria-label={`${S.chatsTitle}: ${session.repo.split("/")[1]}`}>
          <Avatar name={me.nick} seed={me.id} shape={me.kind === "agent" ? "agent" : "person"} size={28} picture={pictureOf(me)} />
          <span className="me-text"><b>{handle(me)}</b><span className="muted">{session.repo.split("/")[1]}</span></span>
          <span className="me-end">
            {Object.values(activity).some(Boolean) && <i className="activity" aria-label={S.newActivity} />}
            <svg className="chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
        </button>
        <div className="filter"><input type="search" value={filter} placeholder={S.searchAll} aria-label={S.search} onChange={(e) => setFilter(e.target.value)} /></div>
        <nav ref={setNavEl}>
          {(pull > 0 || refreshing) && (
            <div className="pull" style={{ height: refreshing ? 36 : pull }} aria-live="polite">
              {refreshing ? <><span className="spinner" aria-hidden="true" /> {S.refreshing}</> : pull >= PULL ? S.releaseToRefresh : S.pullToRefresh}
            </div>
          )}
          {shown(`#all ${S.everyone}`) && <ChannelRow avatar={<Avatar name="all" seed="all" shape="group" />} label="#all" preview={preview("all") || S.everyone} time={last("all")?.ts} quiet={quiet("all")} count={unread("all")} activeCh={active === "all"} onClick={() => open("all")} />}
          <div className="section">{S.groups} <button className="mini" onClick={() => setDialog("group")}>{S.newGroupButton}</button></div>
          {myGroups.length === 0 && <p className="muted small">{S.noGroups}</p>}
          {myGroups.filter((g) => shown(g.name)).sort((a, b) => recent(a.channel, b.channel) || a.name.localeCompare(b.name, LOCALE)).map((g) => (
            <ChannelRow key={g.channel} avatar={<Avatar name={g.name} seed={g.channel} shape="group" />} label={`#${g.name}`} preview={preview(g.channel) || S.members(g.members.length)}
              time={last(g.channel)?.ts} quiet={quiet(g.channel)} count={unread(g.channel)} activeCh={active === g.channel} onClick={() => open(g.channel)} />
          ))}
          <div className="section">{S.peopleAndAgents}</div>
          {others.filter((d) => shown(handle(d))).sort((a, b) => recent(dmChannel(me.id, a.id), dmChannel(me.id, b.id)) || a.nick.localeCompare(b.nick, LOCALE)).map((d) => {
            const ch = dmChannel(me.id, d.id);
            return <ChannelRow key={d.id} avatar={<Avatar name={d.nick} seed={d.id} shape={d.kind === "agent" ? "agent" : "person"} online={online(d.id)} picture={pictureOf(d)} />} label={handle(d)}
              preview={preview(ch) || [KIND[d.kind] ?? d.kind, seen(d.id)].filter(Boolean).join(" · ")} time={last(ch)?.ts} quiet={quiet(ch)} count={unread(ch)} activeCh={active === ch} onClick={() => open(ch)} />;
          })}
          {query.length >= 2 && <>
            <div className="section">{S.messagesFound(found.length)}</div>
            {found.slice(0, 100).map((m) => (
              <button key={`${m.channel}/${m.id}`} className="row result" onClick={() => { open(m.channel); setTimeout(() => jumpTo(m.id), 150); }}>
                <span className="row-text">
                  <span className="row-top"><span className="row-label">{chatName(m.channel)}</span><span className="row-time">{when(m.ts)}</span></span>
                  <span className="row-sub"><b>{m.from === me.id ? S.you : m.forwarded ? S.forwarded : m.fromNick}:</b> {highlight(m, query)}</span>
                </span>
              </button>
            ))}
            {found.length > 100 && <p className="muted small">{S.firstResults(100)}</p>}
            <div className="older"><button className="mini" disabled={loadingOlder || olderLeft === 0} onClick={loadOlder}>{loadingOlder ? S.loading : olderLeft === 0 ? S.allSearched : S.searchOlder}</button></div>
          </>}
        </nav>
      </aside>

      <main className="chat">
        <header className="chat-head">
          <button className="icon back" onClick={() => setMobileView("list")} aria-label={S.back}>‹</button>
          <button className="title" onClick={() => setDialog("channel")} title={S.chatDetails}>
            {headAvatar}
            <span className="title-text">
              <b>{title}</b>
              <span className="muted small sub">{headSub}{quiet(active) ? (quiet(active)!.mode === "off" ? S.mutedSuffix : S.mentionsSuffix) : ""}</span>
            </span>
          </button>
          {status && <span className="status">{status}</span>}
          <button className="icon info" title={S.details} aria-label={S.chatDetails} onClick={() => setDialog("channel")}><Info /></button>
        </header>
        {account && <AccountAlert text={account} onFix={() => setDialog("settings")} />}
        <MessageList list={messages[active] ?? []} me={me} bus={bus} devices={devices} authors={!isDm(active)} loading={status === S.loading}
          ticks={(m) => ticksFor(m, recipientsOf(m.channel, me.id, devices, groups), receipts, showRead)}
          quoted={byId} isPinned={(m) => pinned.has(pinKey(m))} reactions={(m) => reactionsOn(m, reactions)} onReact={(m, e) => react(m, myReaction(m) === e ? null : e)} answers={(m) => answersTo(m, messages[m.channel] ?? [])} onAnswer={answer} onReply={(m) => setReply(m)} onJump={jumpTo} onMenu={(m, x, y) => setMenu({ m, x, y })}
          selecting={selected !== null} selected={selected ?? undefined} onToggle={toggleSel} onResend={resend} onDiscard={discard} />
        {selected !== null
          ? <div className="select-bar">
              <button className="ghost" onClick={() => setSelected(null)}>{S.cancel}</button>
              <span className="muted">{S.selected(selected.size)}</span>
              {(() => {
                const msgs = (messages[active] ?? []).filter((m) => selected.has(m.id) && !m.pending && !m.failed && !m.system);
                const all = msgs.length > 0 && msgs.every((m) => pinned.has(pinKey(m)));
                return <span className="actions">
                  <button className="ghost" disabled={!msgs.length} onClick={() => { pin(msgs, !all); setSelected(null); }}>{all ? S.unpin : S.pin}</button>
                  <button className="primary" disabled={!msgs.length} onClick={() => setForwarding(msgs)}>{S.forward}</button>
                </span>;
              })()}
            </div>
          : <Composer key={active} draft={drafts[active]?.text ?? ""} onDraft={(t) => saveDraft(active, t)} onSend={send} reply={reply} onCancelReply={() => setReply(null)}
              editing={editing} onEdit={(t) => { const m = editing!; setEditing(null); if (t !== m.text) amend(m, t); }} onCancelEdit={() => setEditing(null)} people={(activeGroup ? devices.filter((d) => activeGroup.members.includes(d.id)) : isDm(active) ? devices.filter((d) => d.id === dmPeer(active, me.id)) : devices).filter((d) => d.id !== me.id)} />}
      </main>

      {dialog === "group" && <GroupDialog others={others} onClose={() => setDialog(null)} onCreate={async (name, ids) => {
        const g = await bus.createGroup(name, ids, me);
        setGroups((x) => [...x, g]); setMessages((x) => ({ ...x, [g.channel]: [] })); setDialog(null); open(g.channel);
        await watcher.refresh();
      }} />}
      {dialog === "channel" && <ChannelDialog key={active} channel={active} title={title} group={activeGroup} me={me} devices={devices} quiet={quiet(active)}
        pins={pins.filter((p) => p.channel === active)} loaded={byId} bus={bus} onUnpin={(m) => pin([m], false)}
        onOpen={(id) => { setDialog(null); setTimeout(() => jumpTo(id), 60); }}
        onQuiet={(q) => saveQuiet(active, q)} onChange={(change) => changeGroup(activeGroup!, change)} onClose={() => setDialog(null)} />}
      {dialog === "chats" && (
        <Sheet title={S.chatsTitle} onClose={() => setDialog(null)}>
          <div className="picker">
            {chats.map((c) => (
              <button key={c.repo} className={`picker-row ${c.repo === session.repo ? "here" : ""}`} onClick={() => { setDialog(null); if (c.repo !== session.repo) onOpen(c.repo); }}>
                <Avatar name={c.repo.split("/")[1]} seed={c.repo} shape="group" size={34} />
                <span className="chat-pick"><b>{c.repo.split("/")[1]}</b><span className="muted small">{handle(c.repo === session.repo ? me : c.device)} · {c.repo}</span></span>
                {activity[c.repo] && <i className="activity" aria-label={S.newActivity} />}
                {c.repo === session.repo && <span className="muted" aria-label={S.openNow}>✓</span>}
              </button>
            ))}
          </div>
          {onAdd && <div className="actions start"><button className="ghost" onClick={() => { setDialog(null); onAdd(); }}>{S.addChat}</button></div>}
          <p className="muted small">{S.chatsHelp}</p>
        </Sheet>
      )}
      {dialog === "invite" && <InviteDialog bus={bus} me={me} admin={admin} onClose={() => setDialog(null)} />}
      {menu && <MessageMenu m={menu.m} x={menu.x} y={menu.y} mine={menu.m.from === me.id}
        reaction={myReaction(menu.m)} onReact={(e) => { react(menu.m, myReaction(menu.m) === e ? null : e); setMenu(null); }}
        pinned={pinned.has(pinKey(menu.m))} onPin={() => { pin([menu.m], !pinned.has(pinKey(menu.m))); setMenu(null); }}
        onReply={() => { setReply(menu.m); setMenu(null); }}
        onCopy={() => { navigator.clipboard?.writeText(menu.m.text || "").catch(() => {}); setMenu(null); }}
        onForward={() => { setForwarding([menu.m]); setMenu(null); }}
        onSelect={() => { setSelected(new Set([menu.m.id])); setMenu(null); }}
        onEdit={menu.m.from === me.id && menu.m.text && !menu.m.forwarded ? () => { setReply(null); setEditing(menu.m); setMenu(null); } : undefined}
        onDelete={menu.m.from === me.id ? () => { amend(menu.m, null); setMenu(null); } : undefined}
        onClose={() => setMenu(null)} />}
      {forwarding && <ChatPicker me={me} devices={devices} groups={groups} count={forwarding.length} onPick={(ch) => doForward(ch, forwarding)} onClose={() => setForwarding(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {dialog === "settings" && <Settings session={session} me={me} bus={bus} problem={account} onMe={setMe} onSession={onSession} onClose={() => setDialog(null)} onSignOut={onSignOut}
        showRead={showRead} onShowRead={(on) => { try { localStorage.setItem(RECEIPTS_KEY, on ? "on" : "off"); } catch { /* private mode: this session only */ } setShowRead(on); }} />}
    </div>
    </BusContext.Provider>
  );
}

const LATEST = "https://api.github.com/repos/Ege-BULUT/opencommunicate/releases/latest";
const SKIPPED_KEY = "oc.updateSkipped";
/**
 * A newer version. The Windows app downloads it by itself and offers a restart; the Android app and the Mac app
 * (which can't update itself unsigned) link the new APK or dmg from the newest GitHub release, checked at start
 * and every 6 hours. The web app is always the newest, so it shows nothing.
 */
function UpdateBanner() {
  const [offer, setOffer] = useState<{ version: string; url?: string; ready?: boolean } | null>(null);
  useEffect(() => {
    const shell = desktopApp();
    if (!native() && !shell?.info) return;
    let stop = false, timer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      const info = shell?.info ? await shell.info() : null;
      if (info?.selfUpdates) {
        if (info.updateReady) setOffer({ version: info.updateReady, ready: true });
        shell!.onUpdateReady?.((v) => { if (!stop) setOffer({ version: v, ready: true }); });
        return;
      }
      const want = (name: string) => (info ? name.endsWith(`-mac-${info.arch}.dmg`) : name.endsWith(".apk"));
      const check = async () => {
        try {
          const rel = await (await fetch(LATEST)).json();
          const v = String(rel.tag_name ?? "").replace(/^v/, "");
          let skipped = null; try { skipped = localStorage.getItem(SKIPPED_KEY); } catch { /* private mode */ }
          if (stop || !v || !newerVersion(v, __APP_VERSION__) || skipped === v) return;
          setOffer({ version: v, url: (rel.assets ?? []).find((a: { name: string }) => want(a.name))?.browser_download_url ?? rel.html_url });
        } catch { /* offline: the next check */ }
      };
      check();
      timer = setInterval(check, 6 * 3600_000);
    })();
    return () => { stop = true; clearInterval(timer); };
  }, []);
  if (!offer) return null;
  const skip = () => { try { localStorage.setItem(SKIPPED_KEY, offer.version); } catch { /* this session only */ } setOffer(null); };
  return (
    <div className="update" role="status">
      <span>{offer.ready ? S.updateReady(offer.version) : S.updateOut(offer.version)}</span>
      {offer.ready
        ? <button className="primary mini" onClick={() => desktopApp()?.installUpdate?.()}>{S.restartToUpdate}</button>
        : <><button className="primary mini" onClick={() => openLink(offer.url!)}>{S.getUpdate}</button><button className="mini" aria-label={S.later} title={S.later} onClick={skip}>×</button></>}
    </div>
  );
}

function AccountAlert({ text, onFix }: { text: string; onFix: () => void }) {
  return (
    <div className="alert" role="alert">
      <span>{text}</span>
      <button className="ghost" onClick={onFix}>{S.githubAccount}</button>
    </div>
  );
}

const hue = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (name: string) => (name.match(/[\p{L}\p{N}]/gu) ?? ["?"]).slice(0, 2).join("").toLocaleUpperCase(LOCALE);

/** People are round, agents square, groups tinted; the colour comes from the id, so it stays put. */
function Avatar({ name, seed, shape, online, size = 40, picture }: { name: string; seed: string; shape: "person" | "agent" | "group"; online?: boolean; size?: number; picture?: Picture | null }) {
  const bus = useContext(BusContext);
  const [photo, setPhoto] = useState<string | null>(null);
  const path = picture && "photo" in picture ? picture.photo : null;
  useEffect(() => {
    setPhoto(null);
    if (!path || !bus) return;
    let live = true;
    fetchFile(bus, path, true).then((d) => { if (live) setPhoto(objectUrl(path, d, mimeOf({ name: path }))); }).catch(() => {});
    return () => { live = false; };
  }, [bus, path]);
  const src = photo ?? (picture && "seed" in picture ? artDataUrl(picture) : null);
  return (
    <span className={`avatar ${shape} ${src ? "pic" : ""}`} style={{ "--h": hue(seed), width: size, height: size, fontSize: Math.round(size * 0.38) } as CSSProperties} aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : seed === "all" ? "#" : initials(name)}
      {online !== undefined && <i className={`presence ${online ? "on" : ""}`} />}
    </span>
  );
}

/** One line that slides to show its end when it does not fit: still for a moment at the start and at the end. */
function Marquee({ text }: { text: string }) {
  const box = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = box.current, inner = el?.firstElementChild as HTMLElement | null;
    if (!el || !inner || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let run: Animation | undefined;
    const start = () => {
      run?.cancel();
      const shift = inner.offsetWidth - el.clientWidth;
      if (shift <= 0) return;
      const hold = 1500, move = (shift / 30) * 1000; // 30 px a second
      const total = 2 * hold + move, at = hold / total, to = `translateX(-${shift}px)`;
      run = inner.animate([{ transform: "none", offset: 0 }, { transform: "none", offset: at }, { transform: to, offset: 1 - at }, { transform: to, offset: 1 }], { duration: total, iterations: Infinity });
    };
    start();
    const ro = new ResizeObserver(start);
    ro.observe(el);
    return () => { ro.disconnect(); run?.cancel(); };
  }, [text]);
  return <span ref={box} className="marquee" title={text}><span>{text}</span></span>;
}

const Gear = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
const PersonPlus = () => <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6" /></svg>;
const Info = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
const Clip = () => <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5 12.5 21a6 6 0 0 1-8.5-8.5L13 3.5a4 4 0 0 1 5.7 5.7L9.7 18.2a2 2 0 0 1-2.8-2.8L15 7.3" /></svg>;
const PinIcon = ({ size = 12 }: { size?: number }) => <svg className="pin-icon" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M15.5 2.5 21.5 8.5l-1.4 1.4-1.1-.4-3.6 3.6.3 3.9-1.4 1.4-4.2-4.2-5.4 5.4H3v-1.3l5.4-5.4-4.2-4.2 1.4-1.4 3.9.3 3.6-3.6-.4-1.1z" /></svg>;
const Plane = () => <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6v6.4l12 2-12 2z" /></svg>;

/** Today: the time; earlier: the day. */
const when = (iso: string) => new Date(iso).toDateString() === new Date().toDateString() ? time(iso) : new Date(iso).toLocaleDateString(LOCALE, { day: "numeric", month: "short" });

function ChannelRow({ avatar, label, preview, time: ts, count, activeCh, quiet, onClick }: { avatar: ReactNode; label: string; preview?: ReactNode; time?: string; count: number; activeCh: boolean; quiet?: Quiet | null; onClick: () => void }) {
  return (
    <button className={`row ${activeCh ? "active" : ""} ${count ? "unread" : ""}`} onClick={onClick}>
      {avatar}
      <span className="row-text">
        <span className="row-top"><span className="row-label">{label}</span>{ts && <span className="row-time">{when(ts)}</span>}</span>
        <span className="row-bottom">
          <span className="row-sub">{preview}</span>
          {quiet && <span className="quiet" title={quiet.mode === "off" ? S.muted : S.mentionsOnly}>{quiet.mode === "off" ? S.mutedBadge : "@"}</span>}
          {count > 0 && <span className={`badge ${quiet ? "dim" : ""}`}>{count}</span>}
        </span>
      </span>
    </button>
  );
}

/** A line around the first match of `q` in a message, the match marked. */
function highlight(m: Message, q: string): ReactNode {
  const text = (m.text || m.files?.map((f) => `📎 ${f.name}`).join(" ") || "").replace(/\s+/g, " ");
  const low = text.toLocaleLowerCase(LOCALE);
  const i = low.indexOf(q.toLocaleLowerCase(LOCALE));
  if (i < 0 || low.length !== text.length) return snippet({ text, files: undefined }, 90); // a case change that changed the length: no mark
  const from = Math.max(0, i - 30);
  return <>{from > 0 && "…"}{text.slice(from, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length, i + q.length + 80)}</>;
}

const linkify = (text: string) => text.split(/(https?:\/\/\S+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} href={part} onClick={(e) => { e.preventDefault(); openLink(part); }}>{part}</a> : part));
const num = (x: number) => x.toLocaleString(LOCALE, { maximumFractionDigits: 1 });
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1e6 ? `${num(n / 1024)} KB` : `${num(n / 1e6)} MB`);
const time = (iso: string) => new Date(iso).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString(LOCALE, { day: "numeric", month: "long" });

/** System notices in the app's language (the stored text is English, for the CLI and agents). */
function systemText(m: Message, devices: Device[]): string {
  const who = (id: string) => { const d = devices.find((x) => x.id === id); return d ? handle(d) : `#${id}`; };
  const by = `${m.fromNick}#${m.from}`;
  const s = m.system!;
  if (s.type === "join") return S.sysJoined(by);
  if (s.type === "group") return S.sysGroup(by, s.group?.name);
  if (s.type === "edit") return S.sysEdited(by);
  if (s.type === "delete") return S.sysDeleted(by);
  const c = s.change;
  if (!c) return m.text;
  switch (c.type) {
    case "add": return S.sysAdded(by, c.ids.map(who).join(", "));
    case "remove": return S.sysRemoved(by, who(c.id));
    case "admin": return c.id === m.from ? S.sysSelfAdmin(by, c.on) : S.sysAdmin(by, c.on, who(c.id));
    case "rename": return S.sysRenamed(by, c.name);
    case "leave": return S.sysLeft(by);
  }
}

/** A message bubble you can swipe (touch) or drag (mouse) left to reply, and hold / right-click for a menu.
 *  A short horizontal drag reveals a ↩ and fires onSwipe when released past the threshold; a long press with
 *  little movement fires onHold with the point to anchor a menu. A normal tap still works (links, buttons). */
function Swipeable({ className, children, onSwipe, onHold }: { className: string; children: ReactNode; onSwipe: () => void; onHold: (x: number, y: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const dx = useRef(0);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHold = () => { if (hold.current) { clearTimeout(hold.current); hold.current = null; } };
  const begin = (x: number, y: number) => {
    start.current = { x, y }; dx.current = 0;
    clearHold();
    hold.current = setTimeout(() => { if (start.current && Math.abs(dx.current) < 8) { onHold(x, y); start.current = null; if (ref.current) ref.current.style.transform = ""; } }, 500);
  };
  const move = (x: number, y: number) => {
    if (!start.current) return;
    const ddx = x - start.current.x, ddy = y - start.current.y;
    if (Math.abs(ddy) > Math.abs(ddx)) { start.current = null; clearHold(); if (ref.current) ref.current.style.transform = ""; return; } // vertical: let the list scroll
    dx.current = Math.max(-80, Math.min(0, ddx));
    if (Math.abs(ddx) > 6) clearHold();
    if (ref.current) ref.current.style.transform = `translateX(${dx.current}px)`;
  };
  const end = () => {
    clearHold();
    if (ref.current) { ref.current.style.transition = "transform .15s"; ref.current.style.transform = ""; setTimeout(() => { if (ref.current) ref.current.style.transition = ""; }, 160); }
    if (start.current && dx.current <= -48) onSwipe();
    start.current = null; dx.current = 0;
  };
  return (
    <div ref={ref} className={`${className} swipeable`}
      onContextMenu={(e) => { e.preventDefault(); onHold(e.clientX, e.clientY); }}
      onTouchStart={(e) => begin(e.touches[0].clientX, e.touches[0].clientY)}
      onTouchMove={(e) => move(e.touches[0].clientX, e.touches[0].clientY)}
      onTouchEnd={end}
      onPointerDown={(e) => { if (e.pointerType === "mouse") begin(e.clientX, e.clientY); }}
      onPointerMove={(e) => { if (e.pointerType === "mouse") move(e.clientX, e.clientY); }}
      onPointerUp={(e) => { if (e.pointerType === "mouse") end(); }}
      onPointerLeave={(e) => { if (e.pointerType === "mouse" && start.current) end(); }}>
      <span className="swipe-hint" aria-hidden="true">↩</span>
      {children}
    </div>
  );
}

/** The menu a long-press or right-click opens on a message: reply, forward, pin, select, copy. */
function MessageMenu({ m, x, y, mine, pinned, reaction, onReact, onPin, onReply, onCopy, onClose, onForward, onSelect, onEdit, onDelete }: { m: Message; x: number; y: number; mine: boolean; pinned: boolean; reaction: Reaction | null; onReact: (e: Reaction) => void; onPin: () => void; onReply: () => void; onCopy: () => void; onClose: () => void; onForward?: () => void; onSelect?: () => void; onEdit?: () => void; onDelete?: () => void }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    const close = () => onClose();
    document.addEventListener("click", close); document.addEventListener("keydown", close); document.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close); document.removeEventListener("scroll", close, true); };
  }, [onClose]);
  const style: CSSProperties = { left: Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 400) - 180), top: Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 600) - 200) };
  return (
    <div className="msg-menu" style={style} role="menu" onClick={(e) => e.stopPropagation()}>
      <div className="react-row" role="group" aria-label={S.react}>
        {REACTIONS.map((e) => <button key={e} role="menuitemradio" aria-checked={reaction === e} className={reaction === e ? "on" : ""} onClick={() => onReact(e)}>{e}</button>)}
      </div>
      <button role="menuitem" onClick={onReply}>{S.reply}</button>
      {onForward && <button role="menuitem" onClick={onForward}>{S.forwardItem}</button>}
      <button role="menuitem" onClick={onPin}><PinIcon size={13} /> {pinned ? S.unpin : S.pin}</button>
      {onSelect && <button role="menuitem" onClick={onSelect}>{S.selectItem}</button>}
      {m.text && <button role="menuitem" onClick={onCopy}>{S.copyItem}</button>}
      {onEdit && <button role="menuitem" onClick={onEdit}>{S.editItem}</button>}
      {onDelete && (confirm
        ? <div className="confirm"><span>{S.deleteForAll}</span><button className="danger" onClick={onDelete}>{S.deleteYes}</button><button onClick={() => setConfirm(false)}>{S.cancel}</button></div>
        : <button role="menuitem" className="danger" onClick={() => setConfirm(true)}>{S.deleteItem}</button>)}
    </div>
  );
}

const TICK_LABEL: Record<Ticks, string> = S.ticks;
function TickMark({ state }: { state: Ticks }) {
  return (
    <svg className={`ticks ${state}`} viewBox="0 0 18 11" width="17" height="11" role="img" aria-label={TICK_LABEL[state]}>
      <title>{TICK_LABEL[state]}</title>
      <path d={state === "sent" ? "M1.5 5.8 4.8 9 11 2" : "M1 5.8 4.3 9 10.5 2M6.8 7.6 8.3 9 14.5 2"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MessageList({ list, me, bus, devices, authors, loading, ticks, quoted, isPinned, reactions, onReact, answers, onAnswer, onReply, onJump, onMenu, selecting, selected, onToggle, onResend, onDiscard }: { list: Pending[]; me: Device; bus: Bus; devices: Device[]; authors: boolean; loading: boolean; ticks: (m: Message) => Ticks; quoted: (id: string) => Message | undefined; isPinned: (m: Message) => boolean; reactions: (m: Message) => { emoji: Reaction; ids: string[] }[]; onReact: (m: Message, e: Reaction) => void; answers: (m: Message) => Record<string, number | null>; onAnswer: (m: Message, i: number | null) => void; onReply: (m: Message) => void; onJump: (id: string) => void; onMenu: (m: Message, x: number, y: number) => void; selecting: boolean; selected?: Set<string>; onToggle: (id: string) => void; onResend: (m: Message) => void; onDiscard: (m: Message) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [list.length]);
  // messages showing their earlier versions (tap "edited")
  const [openEdits, setOpenEdits] = useState<Set<string>>(new Set());
  const toggleEdits = (id: string) => setOpenEdits((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  if (!list.length) return <div className="messages empty muted">{loading ? S.loadingMessages : S.noMessages}</div>;
  let lastDay = "";
  return (
    <div className="messages">
      {list.map((m, i) => {
        const d = day(m.ts);
        const sep = d !== lastDay ? (lastDay = d) : null;
        if (m.system) return <div key={m.id} className="item">{sep && <div className="day"><span>{sep}</span></div>}{isEditNotice(m)
          ? <button className="system notice" onClick={() => onJump(m.system!.target!)}>{systemText(m, devices)}</button>
          : <div className="system">{systemText(m, devices)}</div>}</div>;
        const mine = m.from === me.id;
        const toMe = !mine && !isDm(m.channel) && addressedTo(m, me);
        const prev = list[i - 1];
        const run = !sep && !!prev && !prev.system && prev.from === m.from && Date.parse(m.ts) - Date.parse(prev.ts) < 5 * 60_000;
        const sender = devices.find((x) => x.id === m.from);
        const q = m.replyTo ? quoted(m.replyTo) : undefined;
        const selectable = selecting && !m.pending && !m.failed && !m.system && !m.deleted;
        const still = !m.pending && !m.failed && !m.deleted; // can be replied to, reacted to, held for the menu
        const checked = !!selected?.has(m.id);
        return (
          <div key={m.id} id={`m-${m.id}`} className={`item ${run ? "run" : ""} ${selecting ? "selecting" : ""} ${checked ? "checked" : ""}`}
            onClick={selectable ? () => onToggle(m.id) : undefined}>
            {sep && <div className="day"><span>{sep}</span></div>}
            <div className={`line ${mine ? "mine" : ""}`}>
              {selecting && <span className={`sel-check ${checked ? "on" : ""}`} aria-hidden="true">{checked ? "✓" : ""}</span>}
              {authors && !mine && (run ? <span className="avatar-gap" /> : <Avatar name={m.fromNick} seed={m.from} shape={sender?.kind === "agent" ? "agent" : "person"} size={32} picture={sender ? pictureOf(sender) : null} />)}
            <Swipeable className={`msg ${mine ? "mine" : ""} ${toMe ? "tome" : ""} ${m.pending ? "pending" : ""} ${m.failed ? "failed" : ""}`}
              onSwipe={() => !selecting && still && onReply(m)} onHold={(x, y) => !selecting && still && onMenu(m, x, y)}>
              {authors && !mine && !run && !m.forwarded && <div className="who" style={{ "--h": hue(m.from) } as CSSProperties}>{m.fromNick}<span className="muted">#{m.from}</span>{sender?.kind === "agent" && <span className="kind-tag">{S.agentTag}</span>}</div>}
              {m.forwarded && <div className="fwd-tag">{S.forwardedTag}</div>}
              {m.replyTo && <button className="quote" onClick={() => onJump(m.replyTo!)}>{q ? <><span className="quote-who">{q.from === me.id ? S.you : q.fromNick}</span><span className="quote-text">{q.deleted ? S.deletedMsg : snippet(q, 90)}</span></> : <span className="quote-text muted">{S.quotedMessage}</span>}</button>}
              {m.deleted && <div className="text deleted">🚫 {S.deletedMsg}</div>}
              {m.text && <div className="text">{linkify(m.text)}</div>}
              {m.edits && openEdits.has(m.id) && <div className="edits" aria-label={S.earlier}>{m.edits.map((e, i) => <div key={i}><span className="muted">{when(e.at)}</span> {e.text}</div>)}</div>}
              {m.files?.map((f, i) => <Attachment key={`${i}-${f.name}`} file={f} bus={bus} />)}
              {m.ask && still && (() => {
                // one button per choice and one to write something else; ✓ marks my answer (the asker sees what others picked)
                const got = answers(m);
                const who = (ids: string[]) => ids.map((id) => (id === me.id ? S.you : handle(devices.find((d) => d.id === id) ?? { nick: "?", id }))).join(", ");
                const pick = (i: number | null) => (e: React.MouseEvent) => { e.stopPropagation(); if (!selecting) onAnswer(m, i); };
                return <div className="choices" role="group" aria-label={S.choices}>
                  {[...m.ask.map((c, i) => [c, i] as const), ...(mine ? [] : [[S.writeAnswer, null] as const])].map(([c, i]) => {
                    const ids = Object.keys(got).filter((id) => got[id] === i);
                    const on = mine ? ids.length > 0 : me.id in got && got[me.id] === i;
                    return <button key={i ?? "other"} className={`choice ${i === null ? "other" : ""} ${on ? "on" : ""}`} disabled={mine} title={who(ids) || undefined} onClick={pick(i)}>
                      {on && "✓ "}{c}{(ids.length > 1 || (authors && ids.length > 0)) && <span>{ids.length}</span>}
                    </button>;
                  })}
                </div>;
              })()}
              <div className="meta">{isPinned(m) && <span title={S.pinned}><PinIcon /></span>}{m.edited && <button className="edited" title={S.showEarlier} onClick={(e) => { e.stopPropagation(); toggleEdits(m.id); }}>{S.edited}</button>}{m.failed ? S.notSent : m.pending ? S.sending : time(m.ts)}{mine && !m.pending && !m.failed && <TickMark state={ticks(m)} />}</div>
              {m.failed && <div className="unsent">
                <button className="mini" onClick={(e) => { e.stopPropagation(); onResend(m); }}>{S.resend}</button>
                <button className="mini" onClick={(e) => { e.stopPropagation(); onDiscard(m); }}>{S.discard}</button>
              </div>}
              {(() => {
                const rs = still ? reactions(m) : [];
                const name = (id: string) => (id === me.id ? S.you : handle(devices.find((d) => d.id === id) ?? { nick: "?", id }));
                return rs.length > 0 && <div className="reacts">{rs.map((r) => (
                  <button key={r.emoji} className={`react ${r.ids.includes(me.id) ? "mine" : ""}`} title={r.ids.map(name).join(", ")} aria-label={`${r.emoji} ${r.ids.map(name).join(", ")}`}
                    onClick={(e) => { e.stopPropagation(); if (!selecting) onReact(m, r.emoji); }}>{r.emoji}{r.ids.length > 1 && <span>{r.ids.length}</span>}</button>
                ))}</div>;
              })()}
            </Swipeable>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

/** Images and videos: a blurred ~1 KB preview with the size until downloaded, then the real thing in the chat.
 *  Other files: a download button. */
function Attachment({ file, bus }: { file: FileRef; bus: Bus }) {
  const kind = kindOf(file);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(false);
  const keep = !!kind && mediaModes()[kind] === "save";
  const load = async () => {
    if (!file.path) return null;
    setBusy(true); setError("");
    try { return await fetchFile(bus, file.path, keep); }
    catch (e) { setError((e as Error).message); return null; }
    finally { setBusy(false); }
  };
  const show = async () => { const data = await load(); if (data) setUrl(objectUrl(file.path, data, mimeOf(file))); };
  const save = async () => { const data = await load(); if (data) await saveFile(file.name, data); };
  // already on this device (kept, or seen this session): no tap needed
  useEffect(() => {
    let live = true;
    if (kind && file.path) isLocal(file.path).then((here) => { if (here && live) show(); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);

  if (!kind) return (
    <button className="attach" disabled={busy || !file.path} onClick={save}>
      📎 {file.name} <span className="muted">{size(file.size)} · {busy ? S.downloadingLower : S.download}</span>
    </button>
  );
  const ratio = file.w && file.h ? Math.min(2, Math.max(0.5, file.w / file.h)) : kind === "video" ? 16 / 9 : 4 / 3;
  if (url) return (
    <div className="media">
      {kind === "image"
        ? <img className="attach-img" src={url} alt={file.name} onClick={() => setZoom(true)} />
        : <video className="attach-video" src={url} controls playsInline preload="metadata" />}
      <div className="media-bar"><span className="muted small">{file.name} · {size(file.size)}</span><button className="mini" disabled={busy} onClick={save}>{S.saveToDevice}</button></div>
      {zoom && <Lightbox url={url} name={file.name} onSave={save} onClose={() => setZoom(false)} />}
    </div>
  );
  return (
    <button className="media-preview" style={{ aspectRatio: String(ratio) }} disabled={busy || !file.path} onClick={show} aria-label={`${file.name}, ${size(file.size)}, ${S.download}`}>
      {file.thumb && <img className="media-thumb" src={file.thumb} alt="" />}
      <span className="media-dl">{busy ? S.downloading : `${kind === "video" ? "▶" : "⬇"} ${size(file.size)}`}</span>
      {error && <span className="media-error">{error}</span>}
    </button>
  );
}

function Lightbox({ url, name, onSave, onClose }: { url: string; name: string; onSave: () => void; onClose: () => void }) {
  useBack(true, onClose);
  return (
        <div className="lightbox" onClick={onClose}>
          <img src={url} alt={name} />
          <div className="actions"><button className="ghost" onClick={(e) => { e.stopPropagation(); onSave(); }}>{S.saveToDevice}</button><button className="ghost" onClick={onClose}>{S.close}</button></div>
        </div>
  );
}

function Composer({ draft, onDraft, onSend, people, reply, onCancelReply, editing, onEdit, onCancelEdit }: { draft: string; onDraft: (text: string) => void; onSend: (text: string, files: File[]) => void; people: Device[]; reply: Message | null; onCancelReply: () => void; editing: Message | null; onEdit: (text: string) => void; onCancelEdit: () => void }) {
  const [text, setText] = useState(draft);
  // a draft from another device shows here until something is typed in this box
  const typed = useRef(false);
  useEffect(() => { if (!typed.current && !editing) setText(draft); }, [draft, editing]);
  const change = (v: string) => { setText(v); if (!editing) { typed.current = true; onDraft(v); } };
  // editing: the box holds the message's text until it is saved or the edit is cancelled
  const before = useRef<string | null>(null); // what the box held before an edit started; null when not editing
  useEffect(() => {
    if (editing) { if (before.current === null) before.current = text; setText(editing.text); replyInput.current?.focus(); }
    else if (before.current !== null) { setText(before.current); before.current = null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  // "@" followed by the start of a nick at the end of the text suggests people in this chat
  const at = text.match(/(^|\s)@([\w-]*)$/);
  const suggest = at ? people.filter((d) => handle(d).toLowerCase().startsWith(at[2].toLowerCase())).slice(0, 6) : [];
  const mention = (d: Device) => change(text.slice(0, text.length - at![2].length - 1) + `@${handle(d)} `);
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const submit = () => {
    if (editing) { if (text.trim()) onEdit(text.trim()); return; }
    if (!text.trim() && !files.length) return;
    if (files.some((f) => f.size > 50e6)) { alert(S.fileTooBig); return; }
    onSend(text.trim(), files);
    setText(""); setFiles([]); typed.current = false;
  };
  const replyInput = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (reply) replyInput.current?.focus(); }, [reply]);
  return (
    <div className="composer">
      {editing && <div className="reply-bar"><span className="reply-strip" /><span className="reply-text"><b>{S.editingLabel}</b><span className="muted"> · {snippet(editing, 70)}</span></span><button className="reply-x" aria-label={S.cancelEdit} onClick={onCancelEdit}>×</button></div>}
      {reply && <div className="reply-bar"><span className="reply-strip" /><span className="reply-text"><b>{reply.fromNick}</b><span className="muted"> · {snippet(reply, 70)}</span></span><button className="reply-x" aria-label={S.cancelReply} onClick={onCancelReply}>×</button></div>}
      {suggest.length > 0 && <div className="chips">{suggest.map((d) => <button key={d.id} className="chip pick-person" onClick={() => mention(d)}>@{handle(d)} <span className="muted">{KIND[d.kind] ?? d.kind}</span></button>)}</div>}
      {files.length > 0 && <div className="chips">{files.map((f, i) => <span key={i} className="chip">📎 {f.name}<button onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}</div>}
      <div className="compose-row">
        <button className="icon attach-btn" disabled={!!editing} title={S.addFile} aria-label={S.addFile} onClick={() => input.current?.click()}><Clip /></button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
        <textarea ref={replyInput} rows={1} value={text} placeholder={people.length > 1 ? S.typeMessageMention : S.typeMessage} onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !native()) { e.preventDefault(); submit(); } }} />
        <button className="primary send" aria-label={editing ? S.saveEdit : S.send} onClick={submit} disabled={!text.trim() && (!files.length || !!editing)}><Plane /><span className="send-label">{editing ? S.saveEdit : S.send}</span></button>
      </div>
    </div>
  );
}

const QUIET_FOR: [string, number | null][] = ([null, 3600e3, 8 * 3600e3, 7 * 86400e3] as const).map((ms, i) => [S.quietFor[i], ms]);

function ChannelDialog({ channel, title, group, me, devices, quiet, pins, loaded, bus, onUnpin, onOpen, onQuiet, onChange, onClose }: {
  channel: string; title: string; group?: Group; me: Device; devices: Device[]; quiet: Quiet | null;
  pins: Pin[]; loaded: (id: string) => Message | undefined; bus: Bus; onUnpin: (m: Pick<Message, "channel" | "id">) => void; onOpen: (id: string) => void;
  onQuiet: (q: Quiet | null) => Promise<void>; onChange: (c: GroupChange) => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"all" | Quiet["mode"]>(quiet?.mode ?? "all");
  const [span, setSpan] = useState(0);
  const [name, setName] = useState(group?.name ?? "");
  const [adding, setAdding] = useState<Set<string> | null>(null);
  const [leaving, setLeaving] = useState(false);
  const admin = !!group && groupAdmins(group).includes(me.id);
  const admins = group ? groupAdmins(group) : [];
  const run = async (f: () => Promise<void>) => { setBusy(true); setError(""); try { await f(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const who = (id: string) => devices.find((d) => d.id === id) ?? { id, nick: "?", kind: "person" as const, joinedAt: "" };
  const saveQuiet = () => run(async () => {
    const ms = QUIET_FOR[span][1];
    await onQuiet(mode === "all" ? null : { mode, ...(ms ? { until: new Date(Date.now() + ms).toISOString() } : {}) });
  });
  const until = quiet?.until ? new Date(quiet.until).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <Sheet title={title} className="channel-card" onClose={onClose}>
        {group && <p className="muted small">{S.groupInfo(group.members.length, admin)}</p>}

        <Pinned pins={pins} loaded={loaded} bus={bus} me={me} onUnpin={onUnpin} onOpen={onOpen} />

        <h3>{S.notifications}</h3>
        <div className="seg" role="radiogroup" aria-label={S.notifications}>
          {([["all", S.all], ["mentions", S.mentionsOnly], ["off", S.muted]] as const).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={mode === v} className={mode === v ? "on" : ""} onClick={() => setMode(v)}>{l}</button>
          ))}
        </div>
        {mode !== "all" && (
          <label className="inline">{S.duration}
            <select value={span} onChange={(e) => setSpan(Number(e.target.value))}>{QUIET_FOR.map(([l], i) => <option key={l} value={i}>{l}</option>)}</select>
          </label>
        )}
        <p className="muted small">{S.quietNow(quiet?.mode ?? null, until)} {S.quietNote}</p>
        <div className="actions start"><button className="primary" disabled={busy} onClick={saveQuiet}>{S.saveNotifications}</button></div>

        {group && <>
          <h3>{S.groupName}</h3>
          {admin ? (
            <div className="compose-row"><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              <button className="ghost" disabled={busy || !name.trim() || name.trim() === group.name} onClick={() => run(() => onChange({ type: "rename", name }))}>{S.save}</button></div>
          ) : <p>{group.name}</p>}

          <h3>{S.membersTitle}</h3>
          <div className="members">
            {[...group.members].sort((a, b) => Number(admins.includes(b)) - Number(admins.includes(a))).map((id) => {
              const d = who(id), isAdmin = admins.includes(id), self = id === me.id;
              return (
                <div key={id} className="member">
                  <Avatar name={d.nick} seed={d.id} shape={d.kind === "agent" ? "agent" : "person"} size={32} picture={pictureOf(d)} />
                  <span className="row-text"><span className="row-label">{handle(d)}{self ? S.youSuffix : ""}</span><span className="row-sub">{KIND[d.kind] ?? d.kind}{isAdmin ? S.adminSuffix : ""}</span></span>
                  {admin && !self && <>
                    <button className="mini" disabled={busy} onClick={() => run(() => onChange({ type: "admin", id, on: !isAdmin }))}>{isAdmin ? S.removeAdmin : S.makeAdmin}</button>
                    <button className="mini danger" disabled={busy} onClick={() => run(() => onChange({ type: "remove", id }))}>{S.remove}</button>
                  </>}
                </div>
              );
            })}
          </div>
          {admin && (adding ? (
            <>
              <div className="pick">
                {devices.filter((d) => !group.members.includes(d.id)).map((d) => (
                  <label key={d.id} className="check"><input type="checkbox" checked={adding.has(d.id)} onChange={() => { const n = new Set(adding); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); setAdding(n); }} />{handle(d)} <span className="muted small">{KIND[d.kind] ?? d.kind}</span></label>
                ))}
                {devices.every((d) => group.members.includes(d.id)) && <p className="muted small">{S.allInGroup}</p>}
              </div>
              <div className="actions start">
                <button className="primary" disabled={busy || !adding.size} onClick={() => run(async () => { await onChange({ type: "add", ids: [...adding] }); setAdding(null); })}>{S.add}</button>
                <button className="ghost" onClick={() => setAdding(null)}>{S.cancel}</button>
              </div>
            </>
          ) : <div className="actions start"><button className="ghost" onClick={() => setAdding(new Set())}>{S.addMember}</button></div>)}

          <div className="actions start">
            {leaving
              ? <><button className="primary danger-fill" disabled={busy} onClick={() => run(() => onChange({ type: "leave" }))}>{S.yesLeave}</button><button className="ghost" onClick={() => setLeaving(false)}>{S.cancel}</button></>
              : <button className="ghost danger" onClick={() => setLeaving(true)}>{S.leaveGroup}</button>}
          </div>
          {leaving && admins.length === 1 && admin && group.members.length > 1 && <p className="muted small">{S.lastAdmin}</p>}
        </>}
        {error && <p className="error">{error}</p>}
        <div className="actions"><button className="ghost" onClick={onClose}>{S.close}</button></div>
    </Sheet>
  );
}

/**
 * A chat's pinned messages in its details, newest pin first, as WhatsApp lists starred ones. A message still in
 * the loaded history opens there; an older one is fetched and opens in place, in full.
 */
function Pinned({ pins, loaded, bus, me, onUnpin, onOpen }: { pins: Pin[]; loaded: (id: string) => Message | undefined; bus: Bus; me: Device; onUnpin: (m: Pick<Message, "channel" | "id">) => void; onOpen: (id: string) => void }) {
  const [fetched, setFetched] = useState<Record<string, Message | null>>({});
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    for (const p of pins) {
      if (loaded(p.id) || p.id in fetched) continue;
      bus.message(p.channel, p.id).then((m) => setFetched((f) => ({ ...f, [p.id]: m })), () => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins]);
  return <>
    <h3 className="pinned-head"><PinIcon size={14} /> {S.pinnedMessages}{pins.length ? ` · ${pins.length}` : ""}</h3>
    {!pins.length && <p className="muted small">{S.pinHelp}</p>}
    <div className="pinned">
      {pins.map((p) => {
        const here = loaded(p.id);
        const m = here ?? fetched[p.id];
        const full = open === p.id;
        return (
          <div key={p.id} className="pinned-row">
            <button className="pinned-body" onClick={() => (here ? onOpen(p.id) : setOpen(full ? null : p.id))} disabled={!m}>
              <span className="pinned-top"><b>{!m ? "" : m.from === me.id ? S.you : m.forwarded ? S.forwarded : `${m.fromNick}#${m.from}`}</b>{m && <span className="muted">{when(m.ts)}</span>}</span>
              <span className={`pinned-text ${full ? "full" : ""}`}>{m === undefined ? S.loading : m === null ? S.messageGone : m.deleted ? S.deletedMsg : full ? m.text || snippet(m) : snippet(m, 160)}</span>
            </button>
            <button className="mini" onClick={() => onUnpin(p)} title={S.unpin} aria-label={S.unpin}>×</button>
          </div>
        );
      })}
    </div>
  </>;
}

/** Pick a chat to forward the selected messages into: #all, a group, or a person/agent. */
function ChatPicker({ me, devices, groups, count, onPick, onClose }: { me: Device; devices: Device[]; groups: Group[]; count: number; onPick: (channel: string) => void; onClose: () => void }) {
  useBack(true, onClose);
  const [q, setQ] = useState("");
  const match = (label: string) => label.toLocaleLowerCase(LOCALE).includes(q.trim().toLocaleLowerCase(LOCALE));
  const myGroups = groups.filter((g) => g.members.includes(me.id));
  const others = devices.filter((d) => d.id !== me.id).sort((a, b) => a.nick.localeCompare(b.nick, LOCALE));
  return (
    <Sheet title={S.forwardN(count)} onClose={onClose}>
      <div className="filter"><input type="search" value={q} placeholder={S.searchChats} aria-label={S.search} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="picker">
        {match(`#all ${S.everyone}`) && <button className="picker-row" onClick={() => onPick("all")}><Avatar name="all" seed="all" shape="group" size={34} /><span>#all</span></button>}
        {myGroups.filter((g) => match(g.name)).map((g) => (
          <button key={g.channel} className="picker-row" onClick={() => onPick(g.channel)}><Avatar name={g.name} seed={g.channel} shape="group" size={34} /><span>#{g.name}</span></button>
        ))}
        {others.filter((d) => match(handle(d))).map((d) => (
          <button key={d.id} className="picker-row" onClick={() => onPick(dmChannel(me.id, d.id))}><Avatar name={d.nick} seed={d.id} shape={d.kind === "agent" ? "agent" : "person"} size={34} picture={pictureOf(d)} /><span>{handle(d)}</span></button>
        ))}
      </div>
    </Sheet>
  );
}

function GroupDialog({ others, onClose, onCreate }: { others: Device[]; onClose: () => void; onCreate: (name: string, ids: string[]) => Promise<void> }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title={S.newGroup} onClose={onClose}>
        <label>{S.groupName}<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <div className="pick">
          {others.map((d) => (
            <label key={d.id} className="check"><input type="checkbox" checked={picked.has(d.id)} onChange={() => { const n = new Set(picked); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); setPicked(n); }} />{handle(d)}</label>
          ))}
        </div>
        <p className="muted small">{S.groupAnnounce}</p>
        <div className="actions">
          <button className="ghost" onClick={onClose}>{S.cancel}</button>
          <button className="primary" disabled={!name.trim() || !picked.size || busy} onClick={async () => { setBusy(true); try { await onCreate(name.trim(), [...picked]); } finally { setBusy(false); } }}>{S.create}</button>
        </div>
    </Sheet>
  );
}

function Settings({ session, me, bus, problem, onMe, onSession, onClose, onSignOut, showRead, onShowRead }: { session: Session; me: Device; bus: Bus; problem: string | null; onMe: (d: Device) => void; onSession: (s: Session) => void; onClose: () => void; onSignOut: () => void; showRead: boolean; onShowRead: (on: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(problem);
  // "Sign in again" only when GitHub refused the account; offline or an outage is not a reason to
  const [mustSignIn, setMustSignIn] = useState(!!problem);
  useEffect(() => {
    checkAccount(sourceFor(session), session.repo).then(
      (l) => { setLogin(l); setTrouble(null); setMustSignIn(false); },
      (e) => { const p = accountProblem(e, session.repo); setTrouble(p ?? S.cantReachGitHub((e as Error).message)); setMustSignIn(!!p); },
    );
  }, [session]);
  // a new token must reach the chat repository before it replaces the old one; it becomes the token of every
  // chat signed in with that GitHub account
  const adoptToken = async (cred: Cred) => {
    let l: string;
    try { l = await checkAccount(cred.token, session.repo); }
    catch (e) { throw new Error(accountProblem(e, session.repo) ?? (e as Error).message); }
    putCred(l, cred);
    const device = { ...me, login: l };
    if (me.login !== l) await new Bus({ repo: session.repo, token: cred.token }).updateDevice(device);
    onSession({ ...session, token: cred.token, device, account: l });
    if (credKey(session) !== l.toLowerCase()) { const c = readStored(); if (c) pruneCreds(c); } // no token left behind for the account switched away from
  };
  // the password on record: undefined while it loads; signing in again takes nick#id and this password
  const [record, setRecord] = useState<PasswordRecord | null | undefined>(undefined);
  const [recordError, setRecordError] = useState("");
  useEffect(() => { bus.passwordRecord(me.id).then(setRecord, (e) => setRecordError(S.cantReadPassword((e as Error).message))); }, [bus, me.id]);
  const [leaving, setLeaving] = useState(false);
  const [picture, setPicture] = useState<Picture | null | undefined>(undefined); // undefined: unchanged
  const [photo, setPhoto] = useState<{ data: Uint8Array; ext: string; url: string } | null>(null);
  const [picError, setPicError] = useState("");
  const [modes, setModes] = useState(mediaModes());
  const [kept, setKept] = useState<number | null>(null);
  useEffect(() => { storedSize().then(setKept); }, []);
  const shown: Picture | null = photo ? null : picture === undefined ? pictureOf(me) : picture;
  const art = shown && "seed" in shown ? shown : null;
  const reroll = () => { setPhoto(null); setPicture({ seed: crypto.randomUUID().slice(0, 8), palette: art?.palette ?? PALETTES[Math.floor(Math.random() * PALETTES.length)].id }); };
  const pickPalette = (id: string) => { setPhoto(null); setPicture({ seed: art?.seed ?? crypto.randomUUID().slice(0, 8), palette: id }); };
  const choosePhoto = async (f?: File) => {
    if (!f) return;
    setPicError("");
    try { setPhoto(await shrinkPhoto(f)); } catch (e) { setPicError((e as Error).message); }
  };
  const savePicture = async () => {
    setBusy(true); setPicError("");
    try {
      const next = await bus.setPicture(me, photo ? { photo: photo.data, ext: photo.ext } : picture && "seed" in picture ? picture : null);
      if (photo && next.picture && "photo" in next.picture) remember(next.picture.photo, photo.data, true);
      onMe(next);
      onSession({ ...session, device: next });
      setPicture(undefined); setPhoto(null);
    } catch (e) { setPicError((e as Error).message); }
    finally { setBusy(false); }
  };
  const changeMode = (k: MediaKind, m: MediaMode) => { setMediaMode(k, m); setModes(mediaModes()); };
  const toggleNotify = async () => {
    setBusy(true);
    try {
      const next: Device = { ...me, notify: me.notify ? undefined : `https://ntfy.sh/opencom-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}` };
      await bus.updateDevice(next);
      onMe(next);
      onSession({ ...session, device: next });
    } finally { setBusy(false); }
  };
  return (
    <Sheet title={S.settings} onClose={onClose}>
        <div className="profile">
          {photo ? <span className="avatar person pic" style={{ width: 72, height: 72 }}><img src={photo.url} alt="" /></span>
            : <Avatar name={me.nick} seed={me.id} shape={me.kind === "agent" ? "agent" : "person"} size={72} picture={shown} />}
          <span><b>{handle(me)}</b> <span className="muted">({KIND[me.kind] ?? me.kind})</span><br /><span className="muted small">{S.chatRepoLine(session.repo)}</span></span>
        </div>
        <h3>{S.profilePicture}</h3>
        <div className="swatches" role="radiogroup" aria-label={S.palette}>
          {PALETTES.map((p) => (
            <button key={p.id} role="radio" aria-checked={art?.palette === p.id} title={S.palettes[p.id] ?? p.name} className={`swatch ${art?.palette === p.id ? "on" : ""}`} onClick={() => pickPalette(p.id)}
              style={{ background: `conic-gradient(${p.colors.map((c, i) => `${c} ${i * 72}deg ${(i + 1) * 72}deg`).join(", ")})` }} />
          ))}
        </div>
        <div className="actions start">
          <button className="ghost" onClick={reroll}>{S.newPattern}</button>
          <label className="ghost file-btn">{S.uploadPhoto}<input type="file" accept="image/*" hidden onChange={(e) => { choosePhoto(e.target.files?.[0]); e.target.value = ""; }} /></label>
          {me.kind !== "agent" && (shown || photo) && <button className="ghost" onClick={() => { setPhoto(null); setPicture(null); }}>{S.initials}</button>}
        </div>
        {photo && <p className="muted small">{S.photoShrunk((photo.data.length / 1024).toFixed(0))}</p>}
        {(picture !== undefined || photo) && <div className="actions start"><button className="primary" disabled={busy} onClick={savePicture}>{S.savePicture}</button><button className="ghost" onClick={() => { setPicture(undefined); setPhoto(null); }}>{S.cancel}</button></div>}
        {picError && <p className="error small">{picError}</p>}
        <h3>{S.githubAccount}</h3>
        {login && !trouble && <p className="small">{S.signedInAccount(login)}</p>}
        {!login && !trouble && <p className="muted small">{S.checking}</p>}
        {trouble && <p className="error small">{trouble}</p>}
        {session.source === "app" ? (
          <div className="actions start">
            <GitHubSignIn label={mustSignIn ? S.signInAgain : S.signInOther} primary={mustSignIn} onToken={adoptToken} />
            {!leaving && <button className="ghost danger" onClick={() => setLeaving(true)}>{S.signOut}</button>}
          </div>
        ) : (
          <p className="muted small">{S.desktopAccount}</p>
        )}
        {leaving && (
          <div className="alert" role="alert">
            <span>{S.signOutWarn(handle(me), record === null)}</span>
            <span className="actions start">
              <button className="ghost danger" onClick={onSignOut}>{S.signOut}</button>
              <button className="ghost" onClick={() => setLeaving(false)}>{S.cancel}</button>
            </span>
          </div>
        )}
        <h3>{record ? S.changePassword : S.password}</h3>
        <p className="muted small">{S.passwordHelp(handle(me))}</p>
        {recordError ? <p className="error small">{recordError}</p>
          : record === undefined ? <p className="muted small">{S.checking}</p>
          : <PasswordForm current={record} username={handle(me)} label={record ? S.changePassword : S.savePassword} onSave={async (pw) => setRecord(await bus.setPassword(me, pw))} />}
        <h3>{S.media}</h3>
        <p className="small">{S.mediaHelp}</p>
        {(["image", "video"] as const).map((k) => (
          <label key={k} className="inline">{k === "image" ? S.images : S.videos}
            <select value={modes[k]} onChange={(e) => changeMode(k, e.target.value as MediaMode)}>
              <option value="save">{S.saveToDevice}</option>
              <option value="stream">{S.stream}</option>
            </select>
          </label>
        ))}
        {kept !== null && <div className="actions start"><span className="muted small">{S.storedHere(size(kept))}</span>{kept > 0 && <button className="mini" onClick={async () => { await clearStored(); setKept(0); }}>{S.clear}</button>}</div>}
        <h3>{S.readReceipts}</h3>
        <label className="inline toggle">
          <input type="checkbox" checked={showRead} onChange={(e) => onShowRead(e.target.checked)} />
          {S.showRead}
        </label>
        <p className="muted small">{S.ticksHelp}</p>
        <h3>{S.push}</h3>
        <p className="small">{S.pushHelp}</p>
        {native() && <button className="ghost" onClick={() => openLink("https://play.google.com/store/apps/details?id=io.heckel.ntfy")}>{S.ntfyPlay}</button>}
        {!native() && platform() === "ios" && <button className="ghost" onClick={() => openLink(NTFY_IOS)}>{S.ntfyAppStore}</button>}
        {me.notify ? (
          <>
            <code className="topic" onClick={() => navigator.clipboard?.writeText(me.notify!)}>{me.notify}</code>
            <div className="actions">
              <button className="ghost" onClick={() => openLink(native() ? me.notify!.replace("https://", "ntfy://") : me.notify!)}>{S.subscribeNtfy}</button>
              <button className="ghost" disabled={busy} onClick={toggleNotify}>{S.turnOff}</button>
            </div>
          </>
        ) : (
          <button className="primary" disabled={busy} onClick={toggleNotify}>{S.createTopic}</button>
        )}
        <h3>{S.language}</h3>
        <LangPicker />
        <p className="muted small">OpenCommunicate {__APP_VERSION__}</p>
        <div className="actions">
          <button className="ghost" onClick={onClose}>{S.close}</button>
        </div>
    </Sheet>
  );
}
