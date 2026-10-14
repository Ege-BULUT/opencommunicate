import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bus, ClaimError, PALETTES, PASSWORD_MIN, Watcher, addressedTo, artDataUrl, dmChannel, dmPeer, groupAdmins, handle, isDm, msgPath, newestByChannel, pictureOf, verifyPassword, quietFor, recipientsOf, snippet, ticksFor, wantsNotice, type Device, type FileRef, type Group, type GroupChange, type Message, type PasswordRecord, type Picture, type Pin, type Quiet, type Receipt, type Receipts, type Ticks } from "../../core/src/index.ts";
import { notifyRecipients } from "../../core/src/notify.ts";
import { INVITE_BASE, acceptInvitation, canAdmit, createInvite, decodeInvite, encodeInvite, inviteMessage, post, processInvites, read, whatsappLink, type InviteCode } from "../../core/src/invite.ts";
import { Share } from "@capacitor/share";
import { App as NativeApp } from "@capacitor/app";
import { askNotifications, notify, openLink, saveFile } from "./platform.ts";
import { clearStored, describe, fetchFile, isLocal, kindOf, mediaModes, mimeOf, objectUrl, remember, setMediaMode, shrinkPhoto, storedSize, type MediaKind, type MediaMode } from "./media.ts";
import { accountProblem, canSignIn, checkAccount, claim, clearSession, desktopApp, finishSignIn, githubLogin, hosted, join, loadSession, native, saveSession, setPassword, startSignIn, type DeviceCode, type Session } from "./session.ts";

const POLL_MS = 4000;

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
        <div className="sheet-head"><h2>{title}</h2><button className="icon close" aria-label="Kapat" title="Kapat" onClick={onClose}>×</button></div>
        {children}
      </div>
    </div>
  );
}
const BusContext = createContext<Bus | null>(null);
const KIND: Record<string, string> = { agent: "ajan", phone: "telefon", desktop: "masaüstü", person: "kişi" };
const READ_KEY = "oc.read";
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
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [arrival, setArrival] = useState<Arrival>(() => arrivalFrom(location.href));
  useEffect(() => { loadSession().then(setSession).catch(() => setSession(null)); }, []);
  useEffect(() => {
    if (!native()) return;
    NativeApp.getLaunchUrl().then((u) => { if (u?.url) setArrival(arrivalFrom(u.url)); });
    const l = NativeApp.addListener("appUrlOpen", ({ url }) => setArrival(arrivalFrom(url)));
    return () => { l.then((h) => h.remove()); };
  }, []);
  if (session === undefined) return <div className="center muted">Açılıyor…</div>;
  const use = (s: Session) => { saveSession(s); setSession(s); };
  const forget = () => { setArrival(noArrival); if (location.hash.includes("invite=")) history.replaceState(null, "", location.pathname + location.search); };
  if (!session) return <Onboarding arrival={arrival} onDone={(s) => { forget(); use(s); }} />;
  // an invitation to another chat while signed in to one: this device can be in one chat at a time
  if (arrival.invite && arrival.invite.r.toLowerCase() !== session.repo.toLowerCase()) return (
    <div className="center"><div className="card">
      <h1 className="brand">Davet</h1>
      <p><b>{arrival.invite.n}</b> seni <b>{arrival.invite.r.split("/")[1]}</b> sohbetine davet ediyor. Bu cihaz şu an <b>{session.repo.split("/")[1]}</b> sohbetinde.</p>
      <p className="muted small">Katılırsan bu cihaz şu anki sohbetten çıkar; mesajlar repoda kalır, sonra geri dönebilirsin.</p>
      <div className="actions start">
        <button className="primary" onClick={() => { clearSession(); setSession(null); }}>Davete katıl</button>
        <button className="ghost" onClick={forget}>Vazgeç</button>
      </div>
    </div></div>
  );
  // a new token (signed in again, or another account) starts the chat afresh
  return <Chat key={session.token} session={session} onSession={use} onSignOut={() => { clearSession(); setSession(null); }} />;
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
      <h1 className="brand">Hazırsın 🎉</h1>
      <p><b>{handle(session.device)}</b> olarak <b>{session.repo.split("/")[1]}</b> sohbetine katıldın.</p>
      {p === "ios" && !standalone && (
        <ol className="steps">
          <li>Safari'de alttaki <b>Paylaş</b> düğmesine (kareden çıkan ok) bas, <b>Ana Ekrana Ekle</b>'yi seç. OpenCommunicate ana ekranında uygulama gibi açılır.</li>
          <li>Ana ekrandaki simgeden açınca bir kez daha <b>GitHub ile giriş yap</b>, sonra <b>Hesabım var</b> ile <b>{handle(session.device)}</b> ve şifrenle gir.</li>
          <li>Uygulama kapalıyken bildirim için ücretsiz <a href={NTFY_IOS} target="_blank" rel="noreferrer">ntfy</a> uygulamasını kur, sonra OpenCommunicate'te Ayarlar → <b>Bildirim konusu oluştur</b>.</li>
        </ol>
      )}
      {p === "android" && (
        <ol className="steps">
          <li><a href={SITE} target="_blank" rel="noreferrer">Android uygulamasını indir</a> ve kur (Android "bilinmeyen kaynak" izni isterse ver).</li>
          <li>Kurduktan sonra: <a href={`opencommunicate://join?repo=${encodeURIComponent(session.repo)}`}>Uygulamada aç</a>. GitHub ile giriş yap, sonra <b>Hesabım var</b> ile <b>{handle(session.device)}</b> ve şifrenle gir.</li>
        </ol>
      )}
      {p === "desktop" && <p>İstersen <a href={SITE} target="_blank" rel="noreferrer">Mac ya da Windows uygulamasını indir</a>; ya da bu tarayıcıda devam et.</p>}
      <button className="primary" onClick={onContinue}>{p === "ios" && !standalone ? "Şimdilik tarayıcıda devam et" : "Sohbete geç"}</button>
    </div></div>
  );
}

/** Phone app: an invitation link copied from a message, for when the link opened the browser instead. */
function PasteInvite({ onInvite }: { onInvite: (c: InviteCode) => void }) {
  const [text, setText] = useState("");
  const code = decodeInvite(text);
  return (
    <details className="paste">
      <summary>Davet bağlantım var</summary>
      <input value={text} placeholder="Davet bağlantısını yapıştırın" onChange={(e) => setText(e.target.value)} />
      {text && !code && <p className="error small">Bu bir davet bağlantısı değil.</p>}
      {code && <button className="ghost" onClick={() => onInvite(code)}>{code.n} davetiyle devam et</button>}
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
    return inviteMessage(l, handle(me), bus.repo, name.trim() || undefined);
  };
  const run = (f: (text: string) => Promise<void> | void) => async () => {
    setBusy(true); setError(""); setDone("");
    try { await f(await message()); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Sheet title="Kişi davet et" onClose={onClose}>
      <p className="small">Tek kullanımlık bir bağlantı oluşturulur. Davetli bağlantıyı açıp GitHub ile giriş yapınca sohbete eklenir; Android, iPhone ve bilgisayarda çalışır. Bağlantı 3 gün geçerli.</p>
      {!admin && <p className="muted small">Davetleri repo yöneticisinin açık uygulaması onaylar. Senin hesabın bu reponun yöneticisi değil; davetli, yöneticinin uygulaması açıkken eklenir.</p>}
      <label>Adı (isteğe bağlı)<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Ayşe" /></label>
      <label>Telefon numarası<input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+90 5xx xxx xx xx" /></label>
      <div className="actions start">
        <button className="primary" disabled={busy || phone.replace(/\D/g, "").length < 10} onClick={run((t) => openLink(whatsappLink(phone, t)))}>WhatsApp'ta gönder</button>
        <button className="ghost" disabled={busy} onClick={run(async (t) => { await navigator.clipboard.writeText(t); setDone("Mesaj kopyalandı; istediğin yerden gönderebilirsin."); })}>Mesajı kopyala</button>
        {(native() || "share" in navigator) && <button className="ghost" disabled={busy} onClick={run(async (t) => { if (native()) await Share.share({ text: t }); else await navigator.share({ text: t }); })}>Paylaş</button>}
      </div>
      {link && <p className="muted small">Bağlantı oluşturuldu. Aynı pencereden tekrar gönderirsen aynı bağlantı gider.</p>}
      {done && <p className="small">{done}</p>}
      {error && <p className="error small">{error}</p>}
    </Sheet>
  );
}

// GitHub device flow: shows the code, opens github.com/login/device, hands the token on
function GitHubSignIn({ label, primary = true, onToken }: { label: string; primary?: boolean; onToken: (token: string) => Promise<void> }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const gone = useRef(false);
  useEffect(() => { gone.current = false; return () => { gone.current = true; }; }, []);
  const go = async () => {
    setError(""); setBusy(true);
    try {
      const c = await startSignIn();
      setCode(c);
      openLink(c.verification_uri).catch(() => {}); // the code stays on screen even if no browser opens
      const token = await finishSignIn(c, () => gone.current);
      setCode(null);
      await onToken(token);
    } catch (e) { if (!gone.current) setError((e as Error).message); }
    finally { if (!gone.current) { setBusy(false); setCode(null); } }
  };
  if (code) return (
    <div className="code">
      <p>github.com/login/device sayfasına bu kodu girin:</p>
      <strong className="usercode" onClick={() => navigator.clipboard?.writeText(code.user_code)}>{code.user_code}</strong>
      <button className="ghost" onClick={() => openLink(code.verification_uri)}>Sayfayı yeniden aç</button>
      <p className="muted small">Onayladıktan sonra burada kendiliğinden devam eder. Başka bir hesap için GitHub sayfasında önce o hesaba geçin.</p>
    </div>
  );
  return <>
    <button className={primary ? "primary" : "ghost"} disabled={busy} onClick={go}>{busy ? "Bekleniyor…" : label}</button>
    {error && <p className="error">{error}</p>}
  </>;
}

/** A new password twice, and the current one first when `current` is a record; `onSave` stores the new one. */
function PasswordForm({ current, label, onSave }: { current?: PasswordRecord | null; label: string; onSave: (password: string) => Promise<void> }) {
  const [old, setOld] = useState("");
  const [pw, setPw] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const save = async () => {
    setBusy(true); setError(""); setDone(false);
    try {
      if (current && !(await verifyPassword(old, current))) throw new Error("Mevcut şifre hatalı.");
      await onSave(pw);
      setOld(""); setPw(""); setAgain(""); setDone(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    {current && <label>Mevcut şifre<input type="password" autoComplete="current-password" value={old} onChange={(e) => setOld(e.target.value)} /></label>}
    <label>{current ? "Yeni şifre" : "Şifre"}<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
    <label>{current ? "Yeni şifre (tekrar)" : "Şifre (tekrar)"}<input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
    {pw && pw.length < PASSWORD_MIN && <p className="muted small">En az {PASSWORD_MIN} karakter.</p>}
    {again && again !== pw && <p className="error small">Şifreler aynı değil.</p>}
    <div className="actions start">
      <button className="primary" disabled={busy || pw.length < PASSWORD_MIN || pw !== again || (!!current && !old)} onClick={save}>{busy ? "Kaydediliyor…" : label}</button>
    </div>
    {done && <p className="small">Şifre kaydedildi.</p>}
    {error && <p className="error small">{error}</p>}
  </>;
}

/** A failed claim in words; wrong handle and wrong password read the same. */
function claimProblem(e: unknown, repo: string): string {
  if (e instanceof ClaimError) return e.reason === "format" ? "Hesabı ad#1234 biçiminde yazın."
    : e.reason === "login" ? "Bu hesabın henüz şifresi yok; ilk girişi, hesabı açan GitHub hesabıyla yapılmalı."
    : "Hesap adı ya da şifre hatalı.";
  return accountProblem(e, repo) ?? (e as Error).message;
}

// ---------------- sign-in + join (phone) ----------------
function Onboarding({ arrival, onDone }: { arrival: Arrival; onDone: (s: Session) => void }) {
  const invite = arrival.invite;
  const [token, setToken] = useState("");
  const [login, setLogin] = useState("");
  const [repo, setRepo] = useState(invite?.r ?? arrival.repo ?? "");
  const [nick, setNick] = useState("");
  // an invited person is new to the chat, so "Yeni hesap" comes first for them; everyone else most likely returns
  const [mode, setMode] = useState<"have" | "new">(invite ? "new" : "have");
  const [account, setAccount] = useState("");
  const [password, setPasswordText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<"signin" | "admit" | "join" | "password" | "next">("signin");
  const [note, setNote] = useState("");
  const [joined, setJoined] = useState<Session | null>(null);

  // invited: ask to be let in, then wait for an admin's app to add us and accept GitHub's invitation
  useEffect(() => {
    if (stage !== "admit" || !invite) return;
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
          if (refused && "reason" in refused) { setError(refused.reason); return; }
          setNote(Date.now() - started < 20_000 ? "Davet onaylanıyor…"
            : `${invite.n} ya da sohbetteki bir yöneticinin uygulaması açık olduğunda onaylanır. Bu sayfayı açık bırak; onaylanınca kendiliğinden devam eder.`);
        } catch (e) { setNote(`Bağlantı sorunu, yeniden deneniyor: ${(e as Error).message}`); }
        await new Promise((r) => setTimeout(r, 4000));
      }
    })();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  if (!canSignIn() && !token) {
    return (
      <div className="center"><div className="card">
        <h1 className="brand">OpenCommunicate</h1>
        <p>Masaüstünde uygulamayı komut satırından açın:</p>
        <pre>opencom ui</pre>
        <p className="muted">İlk kurulum: <code>opencom init &lt;sahip/repo&gt; --nick &lt;ad&gt;</code></p>
      </div></div>
    );
  }

  const signedIn = async (t: string) => {
    const l = await githubLogin(t);
    setToken(t); setLogin(l); setNick(l.toLowerCase().slice(0, 12));
    setRepo((r) => r || `${l}/opencommunicate-chat`);
    setStage(invite ? "admit" : "join");
  };

  const finish = (s: Session) => {
    // on the web the next step depends on the device: install the app, or add this page to the home screen
    if (hosted()) {
      history.replaceState(null, "", `${location.pathname}?repo=${encodeURIComponent(s.repo)}`);
      setJoined(s); setStage("next");
    } else onDone(s);
  };

  const doJoin = async () => {
    setError(""); setBusy(true);
    try { setJoined(await join(token, repo.trim(), nick.trim())); setStage("password"); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const doClaim = async () => {
    setError(""); setBusy(true);
    try {
      const { session: s, needsPassword } = await claim(token, repo.trim(), account, password);
      if (needsPassword) { setJoined(s); setStage("password"); } else finish(s);
    }
    catch (e) { setError(claimProblem(e, repo.trim())); }
    finally { setBusy(false); }
  };

  if (stage === "next" && joined) return <NextSteps session={joined} onContinue={() => onDone(joined)} />;

  return (
    <div className="center"><div className="card">
      <h1 className="brand">OpenCommunicate</h1>
      {invite && <p className="invite-note"><b>{invite.n}</b> seni <b>{invite.r.split("/")[1]}</b> sohbetine davet ediyor.</p>}
      {stage === "signin" && (
        <>
          <p>Kişiler ve ajanlar, özel bir GitHub reposu üzerinden mesajlaşır. {invite ? "Katılmak" : "Başlamak"} için GitHub ile giriş yapın.</p>
          <GitHubSignIn label="GitHub ile giriş yap" onToken={signedIn} />
          {invite && <p className="muted small">GitHub hesabın yoksa github.com'da ücretsiz açıp buraya dönebilirsin.</p>}
          {!invite && native() && <PasteInvite onInvite={(c) => { setRepo(c.r); location.hash = `invite=${encodeInvite(c)}`; location.reload(); }} />}
        </>
      )}
      {stage === "admit" && (
        <>
          <p>Giriş yapıldı: <b>{login}</b>.</p>
          {!error && <p className="muted"><span className="spinner" aria-hidden="true" /> {note || "Davet onaylanıyor…"}</p>}
        </>
      )}
      {stage === "join" && (
        <>
          <p>Giriş yapıldı: <b>{login}</b>. {invite ? "Sohbete eklendin." : "Hangi sohbete katılıyorsunuz?"}</p>
          <div className="actions start" role="radiogroup" aria-label="Hesap">
            <button role="radio" aria-checked={mode === "have"} className={mode === "have" ? "primary" : "ghost"} onClick={() => { setMode("have"); setError(""); }}>Hesabım var</button>
            <button role="radio" aria-checked={mode === "new"} className={mode === "new" ? "primary" : "ghost"} onClick={() => { setMode("new"); setError(""); }}>Yeni hesap</button>
          </div>
          {!invite && <label>Sohbet reposu<input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="sahip/repo" /></label>}
          {mode === "have" ? <>
            <label>Hesap (ad#1234)<input value={account} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="ad#1234" onChange={(e) => setAccount(e.target.value)} /></label>
            <label>Şifre<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPasswordText(e.target.value)} /></label>
            <button className="primary" disabled={busy || !repo.includes("/") || !account.includes("#")} onClick={doClaim}>{busy ? "Bağlanıyor…" : "Giriş yap"}</button>
          </> : <>
            <label>Takma ad<input value={nick} maxLength={24} onChange={(e) => setNick(e.target.value)} /></label>
            <p className="muted">{invite ? "" : "Repo yoksa private olarak oluşturulur. "}Size ad#1234 biçiminde bir kimlik verilir, sonra bir şifre belirlersiniz.</p>
            <button className="primary" disabled={busy || !repo.includes("/") || !nick.trim()} onClick={doJoin}>{busy ? "Bağlanıyor…" : "Katıl"}</button>
          </>}
        </>
      )}
      {stage === "password" && joined && (
        <>
          <p>Hesabın: <b>{handle(joined.device)}</b>. Bir şifre belirle; çıkış yapınca ya da başka bir cihazdan bu hesapla <b>{handle(joined.device)}</b> ve şifreyle girersin.</p>
          <PasswordForm label="Şifreyi kaydet" onSave={async (pw) => { await setPassword(joined, pw); finish(joined); }} />
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div></div>
  );
}

// ---------------- chat ----------------
type Pending = Message & { pending?: boolean; failed?: boolean };

function Chat({ session, onSession, onSignOut }: { session: Session; onSession: (s: Session) => void; onSignOut: () => void }) {
  const bus = useMemo(() => new Bus({ repo: session.repo, token: session.token }), [session]);
  const [me, setMe] = useState<Device>(session.device);
  const watcher = useMemo(() => new Watcher(bus, session.device), [bus, session.device]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [presence, setPresence] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, Pending[]>>({});
  const [active, setActive] = useState("all");
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [dialog, setDialog] = useState<"group" | "settings" | "channel" | "invite" | null>(null);
  const [admin, setAdmin] = useState(false);
  const [toast, setToast] = useState("");
  const [status, setStatus] = useState("Yükleniyor…");
  const [account, setAccount] = useState<string | null>(null); // a GitHub problem only the person can fix
  const [read, setRead] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(READ_KEY) ?? "{}"); } catch { return {}; } });
  const [receipts, setReceipts] = useState<Receipts>({});
  const [pins, setPins] = useState<Pin[]>([]); // this account's pinned messages (shared by every device signed in as it), newest first
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
  const meRef = useRef(me);
  meRef.current = me;

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

  // start: directory + recent history of every channel, then poll
  useEffect(() => {
    let stop = false;
    // coming back to the app checks at once instead of waiting out the interval
    let wake = () => {};
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
        setDevices(watcher.devices); setGroups(watcher.groups);
        // the repository's devices/<id>.json is the truth (another client may have changed it)
        const stored = watcher.devices.find((d) => d.id === session.device.id);
          if (stored) { setMe(stored); if (session.source === "app") saveSession({ ...session, device: stored }); }
          else if (watcher.devices.length) { setStatus("Bu cihaz sohbetten çıkarılmış. Ayarlar → Çıkış yapıp yeniden katılın."); return; }
          const hist = await bus.histories([...watcher.channels], 60, watcher.head ?? undefined);
          for (const list of Object.values(hist)) list.forEach((m) => watcher.seen.add(msgPath(m)));
          setMessages(hist);
          delivered(Object.values(hist).flat());
          watcher.tickReceipts().then(() => setReceipts(watcher.receipts)).catch(() => {});
          watcher.tickPins().then(() => setPins(watcher.pins)).catch(() => {});
          setStatus(""); setAccount(null);
          bus.presence().then(setPresence).catch(() => {});
          bus.heartbeat(session.device).catch(() => {});
          askNotifications();
          break;
        } catch (e) {
          const problem = accountProblem(e, session.repo);
          setAccount(problem);
          setStatus(problem ? "" : `Bağlanılamadı, yeniden deneniyor: ${(e as Error).message}`);
          await sleep(wait);
        }
      }
      let beat = Date.now();
      let failures = 0;
      while (!stop) {
        await sleep(POLL_MS);
        if (stop) break;
        try {
          const fresh = await watcher.tick();
          setDevices([...watcher.devices]); setGroups([...watcher.groups]);
          add(fresh);
          delivered(fresh);
          if (await watcher.tickReceipts().catch(() => false)) setReceipts(watcher.receipts);
          if (await watcher.tickPins().catch(() => false)) setPins(watcher.pins);
          for (const m of fresh) {
            if (m.from === session.device.id || !wantsNotice(meRef.current, m)) continue;
            if (document.hidden || activeRef.current !== m.channel) notify(`${m.fromNick}#${m.from}`, m.text || "📎 dosya");
          }
          if (Date.now() - beat > 5 * 60_000) { beat = Date.now(); bus.heartbeat(session.device).catch(() => {}); bus.presence().then(setPresence).catch(() => {}); }
          failures = 0;
          setStatus(""); setAccount(null);
        } catch (e) {
          const problem = accountProblem(e, session.repo);
          if (problem) setAccount(problem);
          // phones drop a request now and then (network switch, app waking up); only a run of failures is news
          else if (++failures >= 3) setStatus(`Bağlantı sorunu: ${(e as Error).message}`);
        }
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
          for (const login of await processInvites(bus, meRef.current)) { setToast(`${login} davetle sohbete eklendi.`); setTimeout(() => setToast(""), 8000); }
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
    if (session.source === "app") saveSession({ ...session, device: next });
  };
  const changeGroup = async (g: Group, change: GroupChange) => {
    const next = await bus.changeGroup(g.channel, change, me, devices);
    setGroups((list) => list.map((x) => (x.channel === next.channel ? next : x)));
    await watcher.refresh();
  };
  const unread = (ch: string) => (messages[ch] ?? []).filter((m) => m.from !== me.id && (!read[ch] || m.id > read[ch])).length;
  const online = (id: string) => !!presence[id] && Date.now() - Date.parse(presence[id]) < 10 * 60_000;
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
      setToast(`${sent.length} mesaj ${isDm(channel) ? "@" + handle(devices.find((d) => d.id === dmPeer(channel, me.id)) ?? { nick: "?", id: "" }) : "#" + (channel === "all" ? "all" : groups.find((g) => g.channel === channel)?.name ?? channel)} sohbetine iletildi.`);
      setTimeout(() => setToast(""), 5000);
    } catch (e) { setToast(`İletilemedi: ${(e as Error).message}`); setTimeout(() => setToast(""), 6000); }
  };
  const byId = useCallback((id: string) => (messages[active] ?? []).find((m) => m.id === id), [messages, active]);
  const jumpTo = useCallback((id: string) => {
    const el = document.getElementById(`m-${id}`);
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1200); }
  }, []);
  const pinKey = (m: Pick<Pin, "channel" | "id">) => `${m.channel}/${m.id}`;
  const pinned = useMemo(() => new Set(pins.map(pinKey)), [pins]);
  // shown at once, then replaced by what the pins branch holds; a failed write puts the old list back
  const pin = async (msgs: Pick<Message, "channel" | "id">[], on: boolean) => {
    const before = pins;
    setPins(on ? [...msgs.filter((m) => !pinned.has(pinKey(m))).map((m) => ({ channel: m.channel, id: m.id, at: new Date().toISOString() })), ...pins] : pins.filter((p) => !msgs.some((m) => pinKey(m) === pinKey(p))));
    try { setPins(await bus.setPins(me, msgs, on)); }
    catch (e) { setPins(before); setToast(`${on ? "Sabitlenemedi" : "Sabitleme kaldırılamadı"}: ${(e as Error).message}`); setTimeout(() => setToast(""), 6000); }
  };
  const last = (ch: string) => messages[ch]?.at(-1);
  const recent = (a: string, b: string) => (last(b)?.id ?? "").localeCompare(last(a)?.id ?? "");
  const shown = (label: string) => label.toLocaleLowerCase("tr-TR").includes(filter.trim().toLocaleLowerCase("tr-TR"));
  const preview = (ch: string) => {
    const m = last(ch);
    if (!m) return "";
    const body = m.system ? systemText(m, devices) : m.text || (m.files?.length ? `📎 ${m.files[0].name}` : "");
    if (m.system) return body;
    if (m.from === me.id) return `Siz: ${body}`;
    return isDm(ch) ? body : `${m.fromNick}: ${body}`;
  };
  const seen = (id: string) => (online(id) ? "çevrimiçi" : presence[id] ? `son görülme ${when(presence[id])}` : "");
  const title = active === "all" ? "#all" : isDm(active) ? `@${handle(devices.find((d) => d.id === dmPeer(active, me.id)) ?? { nick: "?", id: dmPeer(active, me.id) })}` : `#${groups.find((g) => g.channel === active)?.name ?? active}`;

  const open = (ch: string) => { setActive(ch); setMobileView("chat"); };
  const narrow = useNarrow();
  useBack(narrow && mobileView === "chat", () => setMobileView("list"));
  const peer = isDm(active) ? devices.find((d) => d.id === dmPeer(active, me.id)) : undefined;
  const headAvatar = peer ? <Avatar name={peer.nick} seed={peer.id} shape={peer.kind === "agent" ? "agent" : "person"} online={online(peer.id)} size={36} picture={pictureOf(peer)} />
    : <Avatar name={activeGroup?.name ?? "all"} seed={activeGroup?.channel ?? "all"} shape="group" size={36} />;
  const headSub = peer ? [KIND[peer.kind] ?? peer.kind, seen(peer.id)].filter(Boolean).join(" · ")
    : activeGroup ? `${activeGroup.members.length} üye` : `herkes · ${devices.length} kişi`;
  const loud = Object.keys(messages).filter((ch) => quietFor(me, ch)?.mode !== "off").reduce((n, ch) => n + unread(ch), 0);
  useEffect(() => { desktopApp()?.badge(loud); }, [loud]);

  const send = async (text: string, files: File[]) => {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()), ...(await describe(f)) })));
    const replyTo = reply?.id;
    const draft: Pending = { ...bus.newMessage(active, me, text, replyTo ? { replyTo } : {}), pending: true, files: payload.map(({ data, ...f }) => ({ ...f, path: "", size: data.length })) };
    add([draft]);
    setReply(null);
    try {
      const sent = await bus.send(active, me, text, payload, replyTo ? { replyTo } : {});
      const modes = mediaModes();
      sent.files?.forEach((f, i) => { const k = kindOf(f); remember(f.path, payload[i].data, !!k && modes[k] === "save"); });
      watcher.seen.add(msgPath(sent));
      setMessages((prev) => ({ ...prev, [active]: [...(prev[active] ?? []).filter((x) => x.id !== draft.id), sent].sort((a, b) => a.id.localeCompare(b.id)) }));
      notifyRecipients(sent, me, devices, groups).catch(() => {});
    } catch (e) {
      setMessages((prev) => ({ ...prev, [active]: (prev[active] ?? []).map((x) => (x.id === draft.id ? { ...x, pending: false, failed: true } : x)) }));
      const problem = accountProblem(e, session.repo);
      if (problem) setAccount(problem); else setStatus(`Gönderilemedi: ${(e as Error).message}`);
    }
  };

  return (
    <BusContext.Provider value={bus}>
    <div className={`layout view-${mobileView}`}>
      <aside className="sidebar">
        <header className="side-head">
          <span className="brand">OpenCommunicate</span>
          <span className="head-buttons">
            <button className="icon" title="Kişi davet et" aria-label="Kişi davet et" onClick={() => setDialog("invite")}><PersonPlus /></button>
            <button className="icon" title="Ayarlar" aria-label="Ayarlar" onClick={() => setDialog("settings")}><Gear /></button>
          </span>
        </header>
        {account && <AccountAlert text={account} onFix={() => setDialog("settings")} />}
        <div className="me">
          <Avatar name={me.nick} seed={me.id} shape={me.kind === "agent" ? "agent" : "person"} size={28} picture={pictureOf(me)} />
          <span className="me-text"><b>{handle(me)}</b><span className="muted">{session.repo.split("/")[1]}</span></span>
        </div>
        <div className="filter"><input type="search" value={filter} placeholder="Sohbet ya da kişi ara" aria-label="Ara" onChange={(e) => setFilter(e.target.value)} /></div>
        <nav>
          {shown("#all herkes") && <ChannelRow avatar={<Avatar name="all" seed="all" shape="group" />} label="#all" preview={preview("all") || "Herkes"} time={last("all")?.ts} quiet={quiet("all")} count={unread("all")} activeCh={active === "all"} onClick={() => open("all")} />}
          <div className="section">Gruplar <button className="mini" onClick={() => setDialog("group")}>+ Yeni grup</button></div>
          {myGroups.length === 0 && <p className="muted small">Henüz grup yok.</p>}
          {myGroups.filter((g) => shown(g.name)).sort((a, b) => recent(a.channel, b.channel) || a.name.localeCompare(b.name, "tr")).map((g) => (
            <ChannelRow key={g.channel} avatar={<Avatar name={g.name} seed={g.channel} shape="group" />} label={`#${g.name}`} preview={preview(g.channel) || `${g.members.length} üye`}
              time={last(g.channel)?.ts} quiet={quiet(g.channel)} count={unread(g.channel)} activeCh={active === g.channel} onClick={() => open(g.channel)} />
          ))}
          <div className="section">Kişiler ve ajanlar</div>
          {others.filter((d) => shown(handle(d))).sort((a, b) => recent(dmChannel(me.id, a.id), dmChannel(me.id, b.id)) || a.nick.localeCompare(b.nick, "tr")).map((d) => {
            const ch = dmChannel(me.id, d.id);
            return <ChannelRow key={d.id} avatar={<Avatar name={d.nick} seed={d.id} shape={d.kind === "agent" ? "agent" : "person"} online={online(d.id)} picture={pictureOf(d)} />} label={handle(d)}
              preview={preview(ch) || [KIND[d.kind] ?? d.kind, seen(d.id)].filter(Boolean).join(" · ")} time={last(ch)?.ts} quiet={quiet(ch)} count={unread(ch)} activeCh={active === ch} onClick={() => open(ch)} />;
          })}
        </nav>
      </aside>

      <main className="chat">
        <header className="chat-head">
          <button className="icon back" onClick={() => setMobileView("list")} aria-label="Geri">‹</button>
          <button className="title" onClick={() => setDialog("channel")} title="Sohbet ayrıntıları">
            {headAvatar}
            <span className="title-text">
              <b>{title}</b>
              <span className="muted small">{headSub}{quiet(active) ? (quiet(active)!.mode === "off" ? " · sessiz" : " · sadece @mention") : ""}</span>
            </span>
          </button>
          {status && <span className="status">{status}</span>}
          <button className="icon info" title="Ayrıntılar" aria-label="Sohbet ayrıntıları" onClick={() => setDialog("channel")}><Info /></button>
        </header>
        {account && <AccountAlert text={account} onFix={() => setDialog("settings")} />}
        <MessageList list={messages[active] ?? []} me={me} bus={bus} devices={devices} authors={!isDm(active)} loading={status === "Yükleniyor…"}
          ticks={(m) => ticksFor(m, recipientsOf(m.channel, me.id, devices, groups), receipts, showRead)}
          quoted={byId} isPinned={(m) => pinned.has(pinKey(m))} onReply={(m) => setReply(m)} onJump={jumpTo} onMenu={(m, x, y) => setMenu({ m, x, y })}
          selecting={selected !== null} selected={selected ?? undefined} onToggle={toggleSel} />
        {selected !== null
          ? <div className="select-bar">
              <button className="ghost" onClick={() => setSelected(null)}>Vazgeç</button>
              <span className="muted">{selected.size} seçildi</span>
              {(() => {
                const msgs = (messages[active] ?? []).filter((m) => selected.has(m.id) && !m.pending && !m.failed && !m.system);
                const all = msgs.length > 0 && msgs.every((m) => pinned.has(pinKey(m)));
                return <span className="actions">
                  <button className="ghost" disabled={!msgs.length} onClick={() => { pin(msgs, !all); setSelected(null); }}>{all ? "Sabitlemeyi kaldır" : "Sabitle"}</button>
                  <button className="primary" disabled={!msgs.length} onClick={() => setForwarding(msgs)}>İlet</button>
                </span>;
              })()}
            </div>
          : <Composer onSend={send} reply={reply} onCancelReply={() => setReply(null)} people={(activeGroup ? devices.filter((d) => activeGroup.members.includes(d.id)) : isDm(active) ? devices.filter((d) => d.id === dmPeer(active, me.id)) : devices).filter((d) => d.id !== me.id)} />}
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
      {dialog === "invite" && <InviteDialog bus={bus} me={me} admin={admin} onClose={() => setDialog(null)} />}
      {menu && <MessageMenu m={menu.m} x={menu.x} y={menu.y} mine={menu.m.from === me.id}
        pinned={pinned.has(pinKey(menu.m))} onPin={() => { pin([menu.m], !pinned.has(pinKey(menu.m))); setMenu(null); }}
        onReply={() => { setReply(menu.m); setMenu(null); }}
        onCopy={() => { navigator.clipboard?.writeText(menu.m.text || "").catch(() => {}); setMenu(null); }}
        onForward={() => { setForwarding([menu.m]); setMenu(null); }}
        onSelect={() => { setSelected(new Set([menu.m.id])); setMenu(null); }}
        onClose={() => setMenu(null)} />}
      {forwarding && <ChatPicker me={me} devices={devices} groups={groups} count={forwarding.length} onPick={(ch) => doForward(ch, forwarding)} onClose={() => setForwarding(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {dialog === "settings" && <Settings session={session} me={me} bus={bus} problem={account} onMe={setMe} onSession={onSession} onClose={() => setDialog(null)} onSignOut={onSignOut}
        showRead={showRead} onShowRead={(on) => { try { localStorage.setItem(RECEIPTS_KEY, on ? "on" : "off"); } catch { /* private mode: this session only */ } setShowRead(on); }} />}
    </div>
    </BusContext.Provider>
  );
}

function AccountAlert({ text, onFix }: { text: string; onFix: () => void }) {
  return (
    <div className="alert" role="alert">
      <span>{text}</span>
      <button className="ghost" onClick={onFix}>GitHub hesabı</button>
    </div>
  );
}

const hue = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (name: string) => (name.match(/[\p{L}\p{N}]/gu) ?? ["?"]).slice(0, 2).join("").toLocaleUpperCase("tr-TR");

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

const Gear = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
const PersonPlus = () => <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6" /></svg>;
const Info = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
const Clip = () => <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5 12.5 21a6 6 0 0 1-8.5-8.5L13 3.5a4 4 0 0 1 5.7 5.7L9.7 18.2a2 2 0 0 1-2.8-2.8L15 7.3" /></svg>;
const PinIcon = ({ size = 12 }: { size?: number }) => <svg className="pin-icon" viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><path d="M15.5 2.5 21.5 8.5l-1.4 1.4-1.1-.4-3.6 3.6.3 3.9-1.4 1.4-4.2-4.2-5.4 5.4H3v-1.3l5.4-5.4-4.2-4.2 1.4-1.4 3.9.3 3.6-3.6-.4-1.1z" /></svg>;
const Plane = () => <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6v6.4l12 2-12 2z" /></svg>;

/** Today: the time; earlier: the day. */
const when = (iso: string) => new Date(iso).toDateString() === new Date().toDateString() ? time(iso) : new Date(iso).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });

function ChannelRow({ avatar, label, preview, time: ts, count, activeCh, quiet, onClick }: { avatar: ReactNode; label: string; preview?: string; time?: string; count: number; activeCh: boolean; quiet?: Quiet | null; onClick: () => void }) {
  return (
    <button className={`row ${activeCh ? "active" : ""} ${count ? "unread" : ""}`} onClick={onClick}>
      {avatar}
      <span className="row-text">
        <span className="row-top"><span className="row-label">{label}</span>{ts && <span className="row-time">{when(ts)}</span>}</span>
        <span className="row-bottom">
          <span className="row-sub">{preview}</span>
          {quiet && <span className="quiet" title={quiet.mode === "off" ? "Sessiz" : "Sadece @mention"}>{quiet.mode === "off" ? "sessiz" : "@"}</span>}
          {count > 0 && <span className={`badge ${quiet ? "dim" : ""}`}>{count}</span>}
        </span>
      </span>
    </button>
  );
}

const linkify = (text: string) => text.split(/(https?:\/\/\S+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} href={part} onClick={(e) => { e.preventDefault(); openLink(part); }}>{part}</a> : part));
const num = (x: number) => x.toLocaleString("tr-TR", { maximumFractionDigits: 1 });
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1e6 ? `${num(n / 1024)} KB` : `${num(n / 1e6)} MB`);
const time = (iso: string) => new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("tr-TR", { day: "numeric", month: "long" });

/** System notices in the app's language (the stored text is English, for the CLI and agents). */
function systemText(m: Message, devices: Device[]): string {
  const who = (id: string) => { const d = devices.find((x) => x.id === id); return d ? handle(d) : `#${id}`; };
  const by = `${m.fromNick}#${m.from}`;
  const s = m.system!;
  if (s.type === "join") return `${by} katıldı`;
  if (s.type === "group") return `${by}, ${s.group?.name ?? "bir"} grubunu kurdu`;
  const c = s.change;
  if (!c) return m.text;
  switch (c.type) {
    case "add": return `${by} ekledi: ${c.ids.map(who).join(", ")}`;
    case "remove": return `${by} gruptan çıkardı: ${who(c.id)}`;
    case "admin": return c.id === m.from ? `${by} ${c.on ? "artık yönetici" : "yöneticilikten ayrıldı"}` : `${by} ${c.on ? "yönetici yaptı" : "yöneticilikten aldı"}: ${who(c.id)}`;
    case "rename": return `${by} grubun adını değiştirdi: ${c.name}`;
    case "leave": return `${by} gruptan ayrıldı`;
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
function MessageMenu({ m, x, y, mine, pinned, onPin, onReply, onCopy, onClose, onForward, onSelect }: { m: Message; x: number; y: number; mine: boolean; pinned: boolean; onPin: () => void; onReply: () => void; onCopy: () => void; onClose: () => void; onForward?: () => void; onSelect?: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    document.addEventListener("click", close); document.addEventListener("keydown", close); document.addEventListener("scroll", close, true);
    return () => { document.removeEventListener("click", close); document.removeEventListener("keydown", close); document.removeEventListener("scroll", close, true); };
  }, [onClose]);
  const style: CSSProperties = { left: Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 400) - 180), top: Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 600) - 200) };
  return (
    <div className="msg-menu" style={style} role="menu" onClick={(e) => e.stopPropagation()}>
      <button role="menuitem" onClick={onReply}>↩ Alıntıla</button>
      {onForward && <button role="menuitem" onClick={onForward}>↪ İlet</button>}
      <button role="menuitem" onClick={onPin}><PinIcon size={13} /> {pinned ? "Sabitlemeyi kaldır" : "Sabitle"}</button>
      {onSelect && <button role="menuitem" onClick={onSelect}>☑ Seç</button>}
      {m.text && <button role="menuitem" onClick={onCopy}>⧉ Kopyala</button>}
    </div>
  );
}

const TICK_LABEL: Record<Ticks, string> = { sent: "gönderildi", delivered: "iletildi", read: "görüldü" };
function TickMark({ state }: { state: Ticks }) {
  return (
    <svg className={`ticks ${state}`} viewBox="0 0 18 11" width="17" height="11" role="img" aria-label={TICK_LABEL[state]}>
      <title>{TICK_LABEL[state]}</title>
      <path d={state === "sent" ? "M1.5 5.8 4.8 9 11 2" : "M1 5.8 4.3 9 10.5 2M6.8 7.6 8.3 9 14.5 2"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MessageList({ list, me, bus, devices, authors, loading, ticks, quoted, isPinned, onReply, onJump, onMenu, selecting, selected, onToggle }: { list: Pending[]; me: Device; bus: Bus; devices: Device[]; authors: boolean; loading: boolean; ticks: (m: Message) => Ticks; quoted: (id: string) => Message | undefined; isPinned: (m: Message) => boolean; onReply: (m: Message) => void; onJump: (id: string) => void; onMenu: (m: Message, x: number, y: number) => void; selecting: boolean; selected?: Set<string>; onToggle: (id: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [list.length]);
  if (!list.length) return <div className="messages empty muted">{loading ? "Mesajlar yükleniyor…" : "Henüz mesaj yok. İlk mesajı siz yazın."}</div>;
  let lastDay = "";
  return (
    <div className="messages">
      {list.map((m, i) => {
        const d = day(m.ts);
        const sep = d !== lastDay ? (lastDay = d) : null;
        if (m.system) return <div key={m.id} className="item">{sep && <div className="day"><span>{sep}</span></div>}<div className="system">{systemText(m, devices)}</div></div>;
        const mine = m.from === me.id;
        const toMe = !mine && !isDm(m.channel) && addressedTo(m, me);
        const prev = list[i - 1];
        const run = !sep && !!prev && !prev.system && prev.from === m.from && Date.parse(m.ts) - Date.parse(prev.ts) < 5 * 60_000;
        const sender = devices.find((x) => x.id === m.from);
        const q = m.replyTo ? quoted(m.replyTo) : undefined;
        const selectable = selecting && !m.pending && !m.failed && !m.system;
        const checked = !!selected?.has(m.id);
        return (
          <div key={m.id} id={`m-${m.id}`} className={`item ${run ? "run" : ""} ${selecting ? "selecting" : ""} ${checked ? "checked" : ""}`}
            onClick={selectable ? () => onToggle(m.id) : undefined}>
            {sep && <div className="day"><span>{sep}</span></div>}
            <div className={`line ${mine ? "mine" : ""}`}>
              {selecting && <span className={`sel-check ${checked ? "on" : ""}`} aria-hidden="true">{checked ? "✓" : ""}</span>}
              {authors && !mine && (run ? <span className="avatar-gap" /> : <Avatar name={m.fromNick} seed={m.from} shape={sender?.kind === "agent" ? "agent" : "person"} size={32} picture={sender ? pictureOf(sender) : null} />)}
            <Swipeable className={`msg ${mine ? "mine" : ""} ${toMe ? "tome" : ""} ${m.pending ? "pending" : ""} ${m.failed ? "failed" : ""}`}
              onSwipe={() => !selecting && !m.pending && !m.failed && onReply(m)} onHold={(x, y) => !selecting && !m.pending && !m.failed && onMenu(m, x, y)}>
              {authors && !mine && !run && !m.forwarded && <div className="who" style={{ "--h": hue(m.from) } as CSSProperties}>{m.fromNick}<span className="muted">#{m.from}</span>{sender?.kind === "agent" && <span className="kind-tag">ajan</span>}</div>}
              {m.forwarded && <div className="fwd-tag">↪ iletildi</div>}
              {m.replyTo && <button className="quote" onClick={() => onJump(m.replyTo!)}>{q ? <><span className="quote-who">{q.from === me.id ? "Siz" : q.fromNick}</span><span className="quote-text">{snippet(q, 90)}</span></> : <span className="quote-text muted">mesaj</span>}</button>}
              {m.text && <div className="text">{linkify(m.text)}</div>}
              {m.files?.map((f, i) => <Attachment key={`${i}-${f.name}`} file={f} bus={bus} />)}
              <div className="meta">{isPinned(m) && <span title="Sabitlendi"><PinIcon /></span>}{m.failed ? "gönderilemedi" : m.pending ? "gönderiliyor…" : time(m.ts)}{mine && !m.pending && !m.failed && <TickMark state={ticks(m)} />}</div>
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
      📎 {file.name} <span className="muted">{size(file.size)} · {busy ? "indiriliyor…" : "indir"}</span>
    </button>
  );
  const ratio = file.w && file.h ? Math.min(2, Math.max(0.5, file.w / file.h)) : kind === "video" ? 16 / 9 : 4 / 3;
  if (url) return (
    <div className="media">
      {kind === "image"
        ? <img className="attach-img" src={url} alt={file.name} onClick={() => setZoom(true)} />
        : <video className="attach-video" src={url} controls playsInline preload="metadata" />}
      <div className="media-bar"><span className="muted small">{file.name} · {size(file.size)}</span><button className="mini" disabled={busy} onClick={save}>Cihaza kaydet</button></div>
      {zoom && <Lightbox url={url} name={file.name} onSave={save} onClose={() => setZoom(false)} />}
    </div>
  );
  return (
    <button className="media-preview" style={{ aspectRatio: String(ratio) }} disabled={busy || !file.path} onClick={show} aria-label={`${file.name}, ${size(file.size)}, indir`}>
      {file.thumb && <img className="media-thumb" src={file.thumb} alt="" />}
      <span className="media-dl">{busy ? "İndiriliyor…" : `${kind === "video" ? "▶" : "⬇"} ${size(file.size)}`}</span>
      {error && <span className="media-error">{error}</span>}
    </button>
  );
}

function Lightbox({ url, name, onSave, onClose }: { url: string; name: string; onSave: () => void; onClose: () => void }) {
  useBack(true, onClose);
  return (
        <div className="lightbox" onClick={onClose}>
          <img src={url} alt={name} />
          <div className="actions"><button className="ghost" onClick={(e) => { e.stopPropagation(); onSave(); }}>Cihaza kaydet</button><button className="ghost" onClick={onClose}>Kapat</button></div>
        </div>
  );
}

function Composer({ onSend, people, reply, onCancelReply }: { onSend: (text: string, files: File[]) => void; people: Device[]; reply: Message | null; onCancelReply: () => void }) {
  const [text, setText] = useState("");
  // "@" followed by the start of a nick at the end of the text suggests people in this chat
  const at = text.match(/(^|\s)@([\w-]*)$/);
  const suggest = at ? people.filter((d) => handle(d).toLowerCase().startsWith(at[2].toLowerCase())).slice(0, 6) : [];
  const mention = (d: Device) => setText(text.slice(0, text.length - at![2].length - 1) + `@${handle(d)} `);
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const submit = () => {
    if (!text.trim() && !files.length) return;
    if (files.some((f) => f.size > 50e6)) { alert("Dosya en fazla 50 MB olabilir."); return; }
    onSend(text.trim(), files);
    setText(""); setFiles([]);
  };
  const replyInput = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => { if (reply) replyInput.current?.focus(); }, [reply]);
  return (
    <div className="composer">
      {reply && <div className="reply-bar"><span className="reply-strip" /><span className="reply-text"><b>{reply.fromNick}</b><span className="muted"> · {snippet(reply, 70)}</span></span><button className="reply-x" aria-label="Alıntıyı iptal et" onClick={onCancelReply}>×</button></div>}
      {suggest.length > 0 && <div className="chips">{suggest.map((d) => <button key={d.id} className="chip pick-person" onClick={() => mention(d)}>@{handle(d)} <span className="muted">{KIND[d.kind] ?? d.kind}</span></button>)}</div>}
      {files.length > 0 && <div className="chips">{files.map((f, i) => <span key={i} className="chip">📎 {f.name}<button onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}</div>}
      <div className="compose-row">
        <button className="icon attach-btn" title="Dosya ekle" aria-label="Dosya ekle" onClick={() => input.current?.click()}><Clip /></button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
        <textarea ref={replyInput} rows={1} value={text} placeholder={people.length > 1 ? "Mesaj yazın · @ ile birini anın" : "Mesaj yazın"} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !native()) { e.preventDefault(); submit(); } }} />
        <button className="primary send" aria-label="Gönder" onClick={submit} disabled={!text.trim() && !files.length}><Plane /><span className="send-label">Gönder</span></button>
      </div>
    </div>
  );
}

const QUIET_FOR: [string, number | null][] = [["Süresiz", null], ["1 saat", 3600e3], ["8 saat", 8 * 3600e3], ["1 hafta", 7 * 86400e3]];

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
  const until = quiet?.until ? new Date(quiet.until).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <Sheet title={title} className="channel-card" onClose={onClose}>
        {group && <p className="muted small">{group.members.length} üye · {admin ? "Bu grubun yöneticisisiniz." : "Üyeleri yalnız yöneticiler değiştirebilir."}</p>}

        <Pinned pins={pins} loaded={loaded} bus={bus} me={me} onUnpin={onUnpin} onOpen={onOpen} />

        <h3>Bildirimler</h3>
        <div className="seg" role="radiogroup" aria-label="Bildirimler">
          {([["all", "Tümü"], ["mentions", "Sadece @mention"], ["off", "Sessiz"]] as const).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={mode === v} className={mode === v ? "on" : ""} onClick={() => setMode(v)}>{l}</button>
          ))}
        </div>
        {mode !== "all" && (
          <label className="inline">Süre
            <select value={span} onChange={(e) => setSpan(Number(e.target.value))}>{QUIET_FOR.map(([l], i) => <option key={l} value={i}>{l}</option>)}</select>
          </label>
        )}
        <p className="muted small">{quiet ? `Şu an: ${quiet.mode === "off" ? "sessiz" : "sadece @mention"}${until ? `, ${until}'e kadar` : ""}.` : "Şu an: her mesajda bildirim."} Ayar kapalı uygulamaya giden ntfy bildirimleri için de geçerli.</p>
        <div className="actions start"><button className="primary" disabled={busy} onClick={saveQuiet}>Bildirim ayarını kaydet</button></div>

        {group && <>
          <h3>Grup adı</h3>
          {admin ? (
            <div className="compose-row"><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              <button className="ghost" disabled={busy || !name.trim() || name.trim() === group.name} onClick={() => run(() => onChange({ type: "rename", name }))}>Kaydet</button></div>
          ) : <p>{group.name}</p>}

          <h3>Üyeler</h3>
          <div className="members">
            {[...group.members].sort((a, b) => Number(admins.includes(b)) - Number(admins.includes(a))).map((id) => {
              const d = who(id), isAdmin = admins.includes(id), self = id === me.id;
              return (
                <div key={id} className="member">
                  <Avatar name={d.nick} seed={d.id} shape={d.kind === "agent" ? "agent" : "person"} size={32} picture={pictureOf(d)} />
                  <span className="row-text"><span className="row-label">{handle(d)}{self ? " (siz)" : ""}</span><span className="row-sub">{KIND[d.kind] ?? d.kind}{isAdmin ? " · yönetici" : ""}</span></span>
                  {admin && !self && <>
                    <button className="mini" disabled={busy} onClick={() => run(() => onChange({ type: "admin", id, on: !isAdmin }))}>{isAdmin ? "Yöneticilikten al" : "Yönetici yap"}</button>
                    <button className="mini danger" disabled={busy} onClick={() => run(() => onChange({ type: "remove", id }))}>Çıkar</button>
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
                {devices.every((d) => group.members.includes(d.id)) && <p className="muted small">Sohbetteki herkes zaten bu grupta.</p>}
              </div>
              <div className="actions start">
                <button className="primary" disabled={busy || !adding.size} onClick={() => run(async () => { await onChange({ type: "add", ids: [...adding] }); setAdding(null); })}>Ekle</button>
                <button className="ghost" onClick={() => setAdding(null)}>Vazgeç</button>
              </div>
            </>
          ) : <div className="actions start"><button className="ghost" onClick={() => setAdding(new Set())}>+ Üye ekle</button></div>)}

          <div className="actions start">
            {leaving
              ? <><button className="primary danger-fill" disabled={busy} onClick={() => run(() => onChange({ type: "leave" }))}>Evet, ayrıl</button><button className="ghost" onClick={() => setLeaving(false)}>Vazgeç</button></>
              : <button className="ghost danger" onClick={() => setLeaving(true)}>Gruptan ayrıl</button>}
          </div>
          {leaving && admins.length === 1 && admin && group.members.length > 1 && <p className="muted small">Tek yönetici sizsiniz; ayrılırsanız yöneticilik gruptaki bir sonraki üyeye geçer.</p>}
        </>}
        {error && <p className="error">{error}</p>}
        <div className="actions"><button className="ghost" onClick={onClose}>Kapat</button></div>
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
    <h3 className="pinned-head"><PinIcon size={14} /> Sabitlenmiş mesajlar{pins.length ? ` · ${pins.length}` : ""}</h3>
    {!pins.length && <p className="muted small">Bir mesaja uzun basıp <b>Sabitle</b>'ye dokun; burada listelenir. Sabitlediklerini yalnız sen görürsün, bu hesapla girdiğin her cihazda.</p>}
    <div className="pinned">
      {pins.map((p) => {
        const here = loaded(p.id);
        const m = here ?? fetched[p.id];
        const full = open === p.id;
        return (
          <div key={p.id} className="pinned-row">
            <button className="pinned-body" onClick={() => (here ? onOpen(p.id) : setOpen(full ? null : p.id))} disabled={!m}>
              <span className="pinned-top"><b>{!m ? "" : m.from === me.id ? "Siz" : m.forwarded ? "iletildi" : `${m.fromNick}#${m.from}`}</b>{m && <span className="muted">{when(m.ts)}</span>}</span>
              <span className={`pinned-text ${full ? "full" : ""}`}>{m === undefined ? "Yükleniyor…" : m === null ? "Bu mesaj artık yok." : full ? m.text || snippet(m) : snippet(m, 160)}</span>
            </button>
            <button className="mini" onClick={() => onUnpin(p)} title="Sabitlemeyi kaldır" aria-label="Sabitlemeyi kaldır">×</button>
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
  const match = (label: string) => label.toLocaleLowerCase("tr-TR").includes(q.trim().toLocaleLowerCase("tr-TR"));
  const myGroups = groups.filter((g) => g.members.includes(me.id));
  const others = devices.filter((d) => d.id !== me.id).sort((a, b) => a.nick.localeCompare(b.nick, "tr"));
  return (
    <Sheet title={`${count} mesajı ilet`} onClose={onClose}>
      <div className="filter"><input type="search" value={q} placeholder="Sohbet ya da kişi ara" aria-label="Ara" onChange={(e) => setQ(e.target.value)} /></div>
      <div className="picker">
        {match("#all herkes") && <button className="picker-row" onClick={() => onPick("all")}><Avatar name="all" seed="all" shape="group" size={34} /><span>#all</span></button>}
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
    <Sheet title="Yeni grup" onClose={onClose}>
        <label>Grup adı<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <div className="pick">
          {others.map((d) => (
            <label key={d.id} className="check"><input type="checkbox" checked={picked.has(d.id)} onChange={() => { const n = new Set(picked); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); setPicked(n); }} />{handle(d)}</label>
          ))}
        </div>
        <p className="muted small">Grup #all kanalında duyurulur; eklenenler grubu kendiliğinden görür.</p>
        <div className="actions">
          <button className="ghost" onClick={onClose}>Vazgeç</button>
          <button className="primary" disabled={!name.trim() || !picked.size || busy} onClick={async () => { setBusy(true); try { await onCreate(name.trim(), [...picked]); } finally { setBusy(false); } }}>Oluştur</button>
        </div>
    </Sheet>
  );
}

function Settings({ session, me, bus, problem, onMe, onSession, onClose, onSignOut, showRead, onShowRead }: { session: Session; me: Device; bus: Bus; problem: string | null; onMe: (d: Device) => void; onSession: (s: Session) => void; onClose: () => void; onSignOut: () => void; showRead: boolean; onShowRead: (on: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(problem);
  useEffect(() => {
    checkAccount(session.token, session.repo).then(
      (l) => { setLogin(l); setTrouble(null); },
      (e) => setTrouble(accountProblem(e, session.repo) ?? `GitHub'a ulaşılamadı: ${(e as Error).message}`),
    );
  }, [session]);
  // a new token must reach the chat repository before it replaces the old one
  const adoptToken = async (token: string) => {
    let l: string;
    try { l = await checkAccount(token, session.repo); }
    catch (e) { throw new Error(accountProblem(e, session.repo) ?? (e as Error).message); }
    const device = { ...me, login: l };
    if (me.login !== l) await new Bus({ repo: session.repo, token }).updateDevice(device);
    onSession({ ...session, token, device });
  };
  // the password on record: undefined while it loads; signing in again takes nick#id and this password
  const [record, setRecord] = useState<PasswordRecord | null | undefined>(undefined);
  const [recordError, setRecordError] = useState("");
  useEffect(() => { bus.passwordRecord(me.id).then(setRecord, (e) => setRecordError(`Şifre bilgisi okunamadı: ${(e as Error).message}`)); }, [bus, me.id]);
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
      if (session.source === "app") saveSession({ ...session, device: next });
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
      if (session.source === "app") saveSession({ ...session, device: next });
    } finally { setBusy(false); }
  };
  return (
    <Sheet title="Ayarlar" onClose={onClose}>
        <div className="profile">
          {photo ? <span className="avatar person pic" style={{ width: 72, height: 72 }}><img src={photo.url} alt="" /></span>
            : <Avatar name={me.nick} seed={me.id} shape={me.kind === "agent" ? "agent" : "person"} size={72} picture={shown} />}
          <span><b>{handle(me)}</b> <span className="muted">({KIND[me.kind] ?? me.kind})</span><br /><span className="muted small">Sohbet reposu: {session.repo}</span></span>
        </div>
        <h3>Profil resmi</h3>
        <div className="swatches" role="radiogroup" aria-label="Renk paleti">
          {PALETTES.map((p) => (
            <button key={p.id} role="radio" aria-checked={art?.palette === p.id} title={p.name} className={`swatch ${art?.palette === p.id ? "on" : ""}`} onClick={() => pickPalette(p.id)}
              style={{ background: `conic-gradient(${p.colors.map((c, i) => `${c} ${i * 72}deg ${(i + 1) * 72}deg`).join(", ")})` }} />
          ))}
        </div>
        <div className="actions start">
          <button className="ghost" onClick={reroll}>Yeni desen</button>
          <label className="ghost file-btn">Fotoğraf yükle<input type="file" accept="image/*" hidden onChange={(e) => { choosePhoto(e.target.files?.[0]); e.target.value = ""; }} /></label>
          {me.kind !== "agent" && (shown || photo) && <button className="ghost" onClick={() => { setPhoto(null); setPicture(null); }}>Baş harfler</button>}
        </div>
        {photo && <p className="muted small">Fotoğraf {(photo.data.length / 1024).toFixed(0)} KB'a küçültüldü.</p>}
        {(picture !== undefined || photo) && <div className="actions start"><button className="primary" disabled={busy} onClick={savePicture}>Profil resmini kaydet</button><button className="ghost" onClick={() => { setPicture(undefined); setPhoto(null); }}>Vazgeç</button></div>}
        {picError && <p className="error small">{picError}</p>}
        <h3>GitHub hesabı</h3>
        {login && !trouble && <p className="small">Giriş yapılan hesap: <b>@{login}</b> ✓</p>}
        {!login && !trouble && <p className="muted small">Kontrol ediliyor…</p>}
        {trouble && <p className="error small">{trouble}</p>}
        {session.source === "app" ? (
          <div className="actions start">
            <GitHubSignIn label={trouble ? "Yeniden giriş yap" : "Farklı hesapla giriş yap"} primary={!!trouble} onToken={adoptToken} />
            {!leaving && <button className="ghost danger" onClick={() => setLeaving(true)}>Çıkış yap</button>}
          </div>
        ) : (
          <p className="muted small">Masaüstünde hesap komut satırından yönetilir: <code>gh auth login</code> (ya da <code>OPENCOM_TOKEN</code>), sonra <code>opencom ui</code>'yi yeniden açın.</p>
        )}
        {leaving && (
          <div className="alert" role="alert">
            <span>Bu cihazda yeniden girmek için hesabın <b>{handle(me)}</b> ve şifren gerekecek.{record === null && " Henüz şifren yok: önce aşağıdan bir şifre belirle; yoksa yalnızca bu GitHub hesabıyla geri dönebilirsin."}</span>
            <span className="actions start">
              <button className="ghost danger" onClick={onSignOut}>Çıkış yap</button>
              <button className="ghost" onClick={() => setLeaving(false)}>Vazgeç</button>
            </span>
          </div>
        )}
        <h3>{record ? "Şifreyi değiştir" : "Şifre"}</h3>
        <p className="muted small">Çıkış yaptıktan sonra ya da başka bir cihazdan GitHub ile girip <b>Hesabım var</b> deyin, <b>{handle(me)}</b> ve bu şifreyi yazın.</p>
        {recordError ? <p className="error small">{recordError}</p>
          : record === undefined ? <p className="muted small">Kontrol ediliyor…</p>
          : <PasswordForm current={record} label={record ? "Şifreyi değiştir" : "Şifreyi kaydet"} onSave={async (pw) => setRecord(await bus.setPassword(me, pw))} />}
        <h3>Medya</h3>
        <p className="small">İndirilen görseller ve videolar: <b>Cihaza kaydet</b> onları bu cihazda saklar, sonra internetsiz de açılır. <b>GitHub'dan aktar</b> her açılışta GitHub'dan getirir, cihazda yer kaplamaz.</p>
        {(["image", "video"] as const).map((k) => (
          <label key={k} className="inline">{k === "image" ? "Görseller" : "Videolar"}
            <select value={modes[k]} onChange={(e) => changeMode(k, e.target.value as MediaMode)}>
              <option value="save">Cihaza kaydet</option>
              <option value="stream">GitHub'dan aktar</option>
            </select>
          </label>
        ))}
        {kept !== null && <div className="actions start"><span className="muted small">Cihazda saklanan: {size(kept)}</span>{kept > 0 && <button className="mini" onClick={async () => { await clearStored(); setKept(0); }}>Temizle</button>}</div>}
        <h3>Görüldü bilgisi</h3>
        <label className="inline toggle">
          <input type="checkbox" checked={showRead} onChange={(e) => onShowRead(e.target.checked)} />
          Mesajları okuduğumu göster (mavi tik)
        </label>
        <p className="muted small">Tek tik: gönderildi. Çift tik: karşı tarafa ulaştı. Mavi çift tik: okundu. Kapatırsanız kimse mesajlarını okuduğunuzu görmez, siz de başkalarının mavi tikini görmezsiniz; ulaştı bilgisi (gri çift tik) iki yönde de çalışmaya devam eder. Grupta tikler, herkese ulaşınca ve herkes okuyunca değişir.</p>
        <h3>Anlık bildirim (ntfy)</h3>
        <p className="small">Uygulama açıkken mesajlar anında gelir. Kapalıyken de haber almak için ücretsiz <b>ntfy</b> uygulamasını kurup aşağıdaki konuya abone olun; size mesaj atan cihaz bu konuya kısa bir bildirim gönderir, bildirime dokununca bu uygulama açılır.</p>
        {native() && <button className="ghost" onClick={() => openLink("https://play.google.com/store/apps/details?id=io.heckel.ntfy")}>ntfy'ı Play Store'dan kur</button>}
        {!native() && platform() === "ios" && <button className="ghost" onClick={() => openLink(NTFY_IOS)}>ntfy'ı App Store'dan kur</button>}
        {me.notify ? (
          <>
            <code className="topic" onClick={() => navigator.clipboard?.writeText(me.notify!)}>{me.notify}</code>
            <div className="actions">
              <button className="ghost" onClick={() => openLink(native() ? me.notify!.replace("https://", "ntfy://") : me.notify!)}>ntfy'da abone ol</button>
              <button className="ghost" disabled={busy} onClick={toggleNotify}>Kapat</button>
            </div>
          </>
        ) : (
          <button className="primary" disabled={busy} onClick={toggleNotify}>Bildirim konusu oluştur</button>
        )}
        <div className="actions">
          <button className="ghost" onClick={onClose}>Kapat</button>
        </div>
    </Sheet>
  );
}
