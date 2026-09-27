import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bus, Watcher, addressedTo, dmChannel, dmPeer, groupAdmins, handle, isDm, msgPath, quietFor, wantsNotice, type Device, type Group, type GroupChange, type Message, type Quiet } from "../../core/src/index.ts";
import { notifyRecipients } from "../../core/src/notify.ts";
import { askNotifications, imageUrl, notify, openLink, saveFile } from "./platform.ts";
import { accountProblem, canSignIn, checkAccount, clearSession, desktopApp, finishSignIn, githubLogin, join, loadSession, native, saveSession, startSignIn, type DeviceCode, type Session } from "./session.ts";

const POLL_MS = 4000;
const KIND: Record<string, string> = { agent: "ajan", phone: "telefon", desktop: "masaüstü", person: "kişi" };
const READ_KEY = "oc.read";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => { loadSession().then(setSession).catch(() => setSession(null)); }, []);
  if (session === undefined) return <div className="center muted">Açılıyor…</div>;
  const use = (s: Session) => { saveSession(s); setSession(s); };
  if (!session) return <Onboarding onDone={use} />;
  // a new token (signed in again, or another account) starts the chat afresh
  return <Chat key={session.token} session={session} onSession={use} onSignOut={() => { clearSession(); setSession(null); }} />;
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

// ---------------- sign-in + join (phone) ----------------
function Onboarding({ onDone }: { onDone: (s: Session) => void }) {
  const [token, setToken] = useState("");
  const [login, setLogin] = useState("");
  const [repo, setRepo] = useState("");
  const [nick, setNick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    setToken(t); setLogin(l); setRepo(`${l}/opencommunicate-chat`); setNick(l.toLowerCase().slice(0, 12));
  };

  const doJoin = async () => {
    setError(""); setBusy(true);
    try { onDone(await join(token, repo.trim(), nick.trim())); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="center"><div className="card">
      <h1 className="brand">OpenCommunicate</h1>
      {!token ? (
        <>
          <p>Kişiler ve ajanlar, özel bir GitHub reposu üzerinden mesajlaşır. Başlamak için GitHub ile giriş yapın.</p>
          <GitHubSignIn label="GitHub ile giriş yap" onToken={signedIn} />
        </>
      ) : (
        <>
          <p>Giriş yapıldı: <b>{login}</b>. Hangi sohbete katılıyorsunuz?</p>
          <label>Sohbet reposu<input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="sahip/repo" /></label>
          <label>Takma ad<input value={nick} maxLength={24} onChange={(e) => setNick(e.target.value)} /></label>
          <p className="muted">Repo yoksa private olarak oluşturulur. Size ad#1234 biçiminde bir kimlik verilir.</p>
          <button className="primary" disabled={busy || !repo.includes("/") || !nick.trim()} onClick={doJoin}>{busy ? "Bağlanıyor…" : "Katıl"}</button>
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
  const [dialog, setDialog] = useState<"group" | "settings" | "channel" | null>(null);
  const [status, setStatus] = useState("Yükleniyor…");
  const [account, setAccount] = useState<string | null>(null); // a GitHub problem only the person can fix
  const [read, setRead] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(READ_KEY) ?? "{}"); } catch { return {}; } });
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

  const markRead = useCallback((ch: string) => {
    const last = messages[ch]?.at(-1)?.id;
    if (!last || read[ch] === last) return;
    const next = { ...read, [ch]: last };
    setRead(next);
    localStorage.setItem(READ_KEY, JSON.stringify(next));
  }, [messages, read]);
  useEffect(() => { if (!document.hidden) markRead(active); }, [active, messages, markRead]);

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
  const peer = isDm(active) ? devices.find((d) => d.id === dmPeer(active, me.id)) : undefined;
  const headAvatar = peer ? <Avatar name={peer.nick} seed={peer.id} shape={peer.kind === "agent" ? "agent" : "person"} online={online(peer.id)} size={36} />
    : <Avatar name={activeGroup?.name ?? "all"} seed={activeGroup?.channel ?? "all"} shape="group" size={36} />;
  const headSub = peer ? [KIND[peer.kind] ?? peer.kind, seen(peer.id)].filter(Boolean).join(" · ")
    : activeGroup ? `${activeGroup.members.length} üye` : `herkes · ${devices.length} kişi`;
  const loud = Object.keys(messages).filter((ch) => quietFor(me, ch)?.mode !== "off").reduce((n, ch) => n + unread(ch), 0);
  useEffect(() => { desktopApp()?.badge(loud); }, [loud]);

  const send = async (text: string, files: File[]) => {
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    const draft: Pending = { ...bus.newMessage(active, me, text), pending: true, files: payload.map((f) => ({ name: f.name, path: "", size: f.data.length })) };
    add([draft]);
    try {
      const sent = await bus.send(active, me, text, payload);
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
    <div className={`layout view-${mobileView}`}>
      <aside className="sidebar">
        <header className="side-head">
          <span className="brand">OpenCommunicate</span>
          <button className="icon" title="Ayarlar" aria-label="Ayarlar" onClick={() => setDialog("settings")}><Gear /></button>
        </header>
        {account && <AccountAlert text={account} onFix={() => setDialog("settings")} />}
        <div className="me">
          <Avatar name={me.nick} seed={me.id} shape={me.kind === "agent" ? "agent" : "person"} size={28} />
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
            return <ChannelRow key={d.id} avatar={<Avatar name={d.nick} seed={d.id} shape={d.kind === "agent" ? "agent" : "person"} online={online(d.id)} />} label={handle(d)}
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
        <MessageList list={messages[active] ?? []} me={me} bus={bus} devices={devices} authors={!isDm(active)} loading={status === "Yükleniyor…"} />
        <Composer onSend={send} people={(activeGroup ? devices.filter((d) => activeGroup.members.includes(d.id)) : isDm(active) ? devices.filter((d) => d.id === dmPeer(active, me.id)) : devices).filter((d) => d.id !== me.id)} />
      </main>

      {dialog === "group" && <GroupDialog others={others} onClose={() => setDialog(null)} onCreate={async (name, ids) => {
        const g = await bus.createGroup(name, ids, me);
        setGroups((x) => [...x, g]); setMessages((x) => ({ ...x, [g.channel]: [] })); setDialog(null); open(g.channel);
        await watcher.refresh();
      }} />}
      {dialog === "channel" && <ChannelDialog key={active} channel={active} title={title} group={activeGroup} me={me} devices={devices} quiet={quiet(active)}
        onQuiet={(q) => saveQuiet(active, q)} onChange={(change) => changeGroup(activeGroup!, change)} onClose={() => setDialog(null)} />}
      {dialog === "settings" && <Settings session={session} me={me} bus={bus} problem={account} onMe={setMe} onSession={onSession} onClose={() => setDialog(null)} onSignOut={onSignOut} />}
    </div>
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
function Avatar({ name, seed, shape, online, size = 40 }: { name: string; seed: string; shape: "person" | "agent" | "group"; online?: boolean; size?: number }) {
  return (
    <span className={`avatar ${shape}`} style={{ "--h": hue(seed), width: size, height: size, fontSize: Math.round(size * 0.38) } as CSSProperties} aria-hidden="true">
      {seed === "all" ? "#" : initials(name)}
      {online !== undefined && <i className={`presence ${online ? "on" : ""}`} />}
    </span>
  );
}

const Gear = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>;
const Info = () => <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
const Clip = () => <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.5 12.5 21a6 6 0 0 1-8.5-8.5L13 3.5a4 4 0 0 1 5.7 5.7L9.7 18.2a2 2 0 0 1-2.8-2.8L15 7.3" /></svg>;
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
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1e6 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`);
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

function MessageList({ list, me, bus, devices, authors, loading }: { list: Pending[]; me: Device; bus: Bus; devices: Device[]; authors: boolean; loading: boolean }) {
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
        return (
          <div key={m.id} className={`item ${run ? "run" : ""}`}>
            {sep && <div className="day"><span>{sep}</span></div>}
            <div className={`line ${mine ? "mine" : ""}`}>
              {authors && !mine && (run ? <span className="avatar-gap" /> : <Avatar name={m.fromNick} seed={m.from} shape={sender?.kind === "agent" ? "agent" : "person"} size={32} />)}
            <div className={`msg ${mine ? "mine" : ""} ${toMe ? "tome" : ""} ${m.pending ? "pending" : ""} ${m.failed ? "failed" : ""}`}>
              {authors && !mine && !run && <div className="who" style={{ "--h": hue(m.from) } as CSSProperties}>{m.fromNick}<span className="muted">#{m.from}</span>{sender?.kind === "agent" && <span className="kind-tag">ajan</span>}</div>}
              {m.text && <div className="text">{linkify(m.text)}</div>}
              {m.files?.map((f, i) => <Attachment key={`${i}-${f.name}`} file={f} bus={bus} />)}
              <div className="meta">{m.failed ? "gönderilemedi" : m.pending ? "gönderiliyor…" : time(m.ts)}</div>
            </div>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function Attachment({ file, bus }: { file: { name: string; path: string; size: number }; bus: Bus }) {
  const [img, setImg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(file.name);
  const get = async () => {
    if (!file.path) return;
    setBusy(true);
    try {
      const data = await bus.file(file.path);
      const url = isImage ? imageUrl(file.name, data) : null;
      if (url) setImg(url); else await saveFile(file.name, data);
    } finally { setBusy(false); }
  };
  if (img) return <img className="attach-img" src={img} alt={file.name} onClick={async () => saveFile(file.name, await bus.file(file.path))} />;
  return (
    <button className="attach" disabled={busy || !file.path} onClick={get}>
      📎 {file.name} <span className="muted">{size(file.size)} · {busy ? "indiriliyor…" : isImage ? "göster" : "indir"}</span>
    </button>
  );
}

function Composer({ onSend, people }: { onSend: (text: string, files: File[]) => void; people: Device[] }) {
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
  return (
    <div className="composer">
      {suggest.length > 0 && <div className="chips">{suggest.map((d) => <button key={d.id} className="chip pick-person" onClick={() => mention(d)}>@{handle(d)} <span className="muted">{KIND[d.kind] ?? d.kind}</span></button>)}</div>}
      {files.length > 0 && <div className="chips">{files.map((f, i) => <span key={i} className="chip">📎 {f.name}<button onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}</div>}
      <div className="compose-row">
        <button className="icon attach-btn" title="Dosya ekle" aria-label="Dosya ekle" onClick={() => input.current?.click()}><Clip /></button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
        <textarea rows={1} value={text} placeholder={people.length > 1 ? "Mesaj yazın · @ ile birini anın" : "Mesaj yazın"} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !native()) { e.preventDefault(); submit(); } }} />
        <button className="primary send" aria-label="Gönder" onClick={submit} disabled={!text.trim() && !files.length}><Plane /><span className="send-label">Gönder</span></button>
      </div>
    </div>
  );
}

const QUIET_FOR: [string, number | null][] = [["Süresiz", null], ["1 saat", 3600e3], ["8 saat", 8 * 3600e3], ["1 hafta", 7 * 86400e3]];

function ChannelDialog({ channel, title, group, me, devices, quiet, onQuiet, onChange, onClose }: {
  channel: string; title: string; group?: Group; me: Device; devices: Device[]; quiet: Quiet | null;
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
    <div className="dialog" onClick={onClose}>
      <div className="card channel-card" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {group && <p className="muted small">{group.members.length} üye · {admin ? "Bu grubun yöneticisisiniz." : "Üyeleri yalnız yöneticiler değiştirebilir."}</p>}

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
      </div>
    </div>
  );
}

function GroupDialog({ others, onClose, onCreate }: { others: Device[]; onClose: () => void; onCreate: (name: string, ids: string[]) => Promise<void> }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <h2>Yeni grup</h2>
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
      </div>
    </div>
  );
}

function Settings({ session, me, bus, problem, onMe, onSession, onClose, onSignOut }: { session: Session; me: Device; bus: Bus; problem: string | null; onMe: (d: Device) => void; onSession: (s: Session) => void; onClose: () => void; onSignOut: () => void }) {
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
    <div className="dialog" onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <h2>Ayarlar</h2>
        <p><b>{handle(me)}</b> <span className="muted">({KIND[me.kind] ?? me.kind})</span></p>
        <p className="muted small">Sohbet reposu: {session.repo}</p>
        <h3>GitHub hesabı</h3>
        {login && !trouble && <p className="small">Giriş yapılan hesap: <b>@{login}</b> ✓</p>}
        {!login && !trouble && <p className="muted small">Kontrol ediliyor…</p>}
        {trouble && <p className="error small">{trouble}</p>}
        {session.source === "app" ? (
          <div className="actions start">
            <GitHubSignIn label={trouble ? "Yeniden giriş yap" : "Farklı hesapla giriş yap"} primary={!!trouble} onToken={adoptToken} />
            <button className="ghost danger" onClick={onSignOut}>Çıkış yap</button>
          </div>
        ) : (
          <p className="muted small">Masaüstünde hesap komut satırından yönetilir: <code>gh auth login</code> (ya da <code>OPENCOM_TOKEN</code>), sonra <code>opencom ui</code>'yi yeniden açın.</p>
        )}
        <h3>Anlık bildirim (ntfy)</h3>
        <p className="small">Uygulama açıkken mesajlar anında gelir. Kapalıyken de haber almak için ücretsiz <b>ntfy</b> uygulamasını kurup aşağıdaki konuya abone olun; size mesaj atan cihaz bu konuya kısa bir bildirim gönderir, bildirime dokununca bu uygulama açılır.</p>
        {native() && <button className="ghost" onClick={() => openLink("https://play.google.com/store/apps/details?id=io.heckel.ntfy")}>ntfy'ı Play Store'dan kur</button>}
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
      </div>
    </div>
  );
}
