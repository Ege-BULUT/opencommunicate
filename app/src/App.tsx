import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bus, Watcher, dmChannel, dmPeer, handle, isDm, msgPath, type Device, type Group, type Message } from "../../core/src/index.ts";
import { notifyRecipients } from "../../core/src/notify.ts";
import { askNotifications, imageUrl, notify, openLink, saveFile } from "./platform.ts";
import { clearSession, finishSignIn, githubLogin, join, loadSession, native, saveSession, startSignIn, type DeviceCode, type Session } from "./session.ts";

const POLL_MS = 4000;
const KIND: Record<string, string> = { agent: "ajan", phone: "telefon", desktop: "masaüstü", person: "kişi" };
const READ_KEY = "oc.read";

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => { loadSession().then(setSession).catch(() => setSession(null)); }, []);
  if (session === undefined) return <div className="center muted">Açılıyor…</div>;
  if (!session) return <Onboarding onDone={(s) => { saveSession(s); setSession(s); }} />;
  return <Chat session={session} onSignOut={() => { clearSession(); setSession(null); }} />;
}

// ---------------- sign-in + join (phone) ----------------
function Onboarding({ onDone }: { onDone: (s: Session) => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [token, setToken] = useState("");
  const [login, setLogin] = useState("");
  const [repo, setRepo] = useState("");
  const [nick, setNick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  if (!native() && !token) {
    return (
      <div className="center"><div className="card">
        <h1 className="brand">OpenCommunicate</h1>
        <p>Masaüstünde uygulamayı komut satırından açın:</p>
        <pre>opencom ui</pre>
        <p className="muted">İlk kurulum: <code>opencom init &lt;sahip/repo&gt; --nick &lt;ad&gt;</code></p>
      </div></div>
    );
  }

  const signIn = async () => {
    setError(""); setBusy(true);
    try {
      const c = await startSignIn();
      setCode(c);
      openLink(c.verification_uri).catch(() => {}); // the code stays on screen even if no browser opens
      const t = await finishSignIn(c, () => cancelled.current);
      const l = await githubLogin(t);
      setToken(t); setLogin(l); setRepo(`${l}/opencommunicate-chat`); setNick(l.toLowerCase().slice(0, 12));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setCode(null); }
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
          {code ? (
            <div className="code">
              <p>github.com/login/device sayfasına bu kodu girin:</p>
              <strong className="usercode" onClick={() => navigator.clipboard?.writeText(code.user_code)}>{code.user_code}</strong>
              <button className="ghost" onClick={() => openLink(code.verification_uri)}>Sayfayı yeniden aç</button>
              <p className="muted">Onayladıktan sonra burada kendiliğinden devam eder.</p>
            </div>
          ) : (
            <button className="primary" disabled={busy} onClick={signIn}>GitHub ile giriş yap</button>
          )}
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

function Chat({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const bus = useMemo(() => new Bus({ repo: session.repo, token: session.token }), [session]);
  const [me, setMe] = useState<Device>(session.device);
  const watcher = useMemo(() => new Watcher(bus, session.device), [bus, session.device]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [presence, setPresence] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, Pending[]>>({});
  const [active, setActive] = useState("all");
  const [mobileView, setMobileView] = useState<"list" | "chat">("list");
  const [dialog, setDialog] = useState<"group" | "settings" | null>(null);
  const [status, setStatus] = useState("Yükleniyor…");
  const [read, setRead] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem(READ_KEY) ?? "{}"); } catch { return {}; } });
  const activeRef = useRef(active);
  activeRef.current = active;

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
    (async () => {
      try {
        await watcher.start();
        setDevices(watcher.devices); setGroups(watcher.groups);
        // the repository's devices/<id>.json is the truth (another client may have changed it)
        const stored = watcher.devices.find((d) => d.id === session.device.id);
        if (stored) { setMe(stored); if (session.source === "app") saveSession({ ...session, device: stored }); }
        else if (watcher.devices.length) { setStatus("Bu cihaz sohbetten çıkarılmış. Ayarlar → Çıkış yapıp yeniden katılın."); return; }
        const hist = await bus.histories([...watcher.channels], 60, watcher.head ?? undefined);
        for (const list of Object.values(hist)) list.forEach((m) => watcher.seen.add(msgPath(m)));
        setMessages(hist);
        setStatus("");
        bus.presence().then(setPresence).catch(() => {});
        bus.heartbeat(session.device).catch(() => {});
        askNotifications();
      } catch (e) { setStatus((e as Error).message); return; }
      let beat = Date.now();
      while (!stop) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        if (stop) break;
        try {
          const fresh = await watcher.tick();
          setDevices([...watcher.devices]); setGroups([...watcher.groups]);
          add(fresh);
          for (const m of fresh) {
            if (m.from === session.device.id) continue;
            if (document.hidden || activeRef.current !== m.channel) notify(`${m.fromNick}#${m.from}`, m.text || "📎 dosya");
          }
          if (Date.now() - beat > 5 * 60_000) { beat = Date.now(); bus.heartbeat(session.device).catch(() => {}); bus.presence().then(setPresence).catch(() => {}); }
          if (status) setStatus("");
        } catch (e) { setStatus(`Bağlantı sorunu: ${(e as Error).message}`); }
      }
    })();
    return () => { stop = true; };
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
  const unread = (ch: string) => (messages[ch] ?? []).filter((m) => m.from !== me.id && (!read[ch] || m.id > read[ch])).length;
  const online = (id: string) => presence[id] && Date.now() - Date.parse(presence[id]) < 10 * 60_000;
  const title = active === "all" ? "#all" : isDm(active) ? `@${handle(devices.find((d) => d.id === dmPeer(active, me.id)) ?? { nick: "?", id: dmPeer(active, me.id) })}` : `#${groups.find((g) => g.channel === active)?.name ?? active}`;

  const open = (ch: string) => { setActive(ch); setMobileView("chat"); };

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
      setStatus(`Gönderilemedi: ${(e as Error).message}`);
    }
  };

  return (
    <div className={`layout view-${mobileView}`}>
      <aside className="sidebar">
        <header className="side-head">
          <span className="brand">OpenCommunicate</span>
          <button className="icon" title="Ayarlar" onClick={() => setDialog("settings")}>⚙︎</button>
        </header>
        <div className="me">{handle(me)} <span className="muted">· {session.repo.split("/")[1]}</span></div>
        <nav>
          <ChannelRow label="#all" sub="Herkes" count={unread("all")} activeCh={active === "all"} onClick={() => open("all")} />
          <div className="section">Gruplar <button className="mini" onClick={() => setDialog("group")}>+ Yeni</button></div>
          {myGroups.length === 0 && <p className="muted small">Henüz grup yok.</p>}
          {myGroups.map((g) => <ChannelRow key={g.channel} label={`#${g.name}`} sub={`${g.members.length} üye`} count={unread(g.channel)} activeCh={active === g.channel} onClick={() => open(g.channel)} />)}
          <div className="section">Kişiler</div>
          {others.map((d) => {
            const ch = dmChannel(me.id, d.id);
            return <ChannelRow key={d.id} label={handle(d)} sub={KIND[d.kind] ?? d.kind} dot={online(d.id) ? "on" : "off"} count={unread(ch)} activeCh={active === ch} onClick={() => open(ch)} />;
          })}
        </nav>
      </aside>

      <main className="chat">
        <header className="chat-head">
          <button className="icon back" onClick={() => setMobileView("list")} aria-label="Geri">‹</button>
          <b>{title}</b>
          {status && <span className="status">{status}</span>}
        </header>
        <MessageList list={messages[active] ?? []} me={me} bus={bus} />
        <Composer onSend={send} />
      </main>

      {dialog === "group" && <GroupDialog others={others} onClose={() => setDialog(null)} onCreate={async (name, ids) => {
        const g = await bus.createGroup(name, ids, me);
        setGroups((x) => [...x, g]); setMessages((x) => ({ ...x, [g.channel]: [] })); setDialog(null); open(g.channel);
        await watcher.refresh();
      }} />}
      {dialog === "settings" && <Settings session={session} me={me} bus={bus} onMe={setMe} onClose={() => setDialog(null)} onSignOut={onSignOut} />}
    </div>
  );
}

function ChannelRow({ label, sub, count, activeCh, dot, onClick }: { label: string; sub?: string; count: number; activeCh: boolean; dot?: "on" | "off"; onClick: () => void }) {
  return (
    <button className={`row ${activeCh ? "active" : ""}`} onClick={onClick}>
      {dot && <i className={`dot ${dot}`} />}
      <span className="row-text"><span className="row-label">{label}</span>{sub && <span className="row-sub">{sub}</span>}</span>
      {count > 0 && <span className="badge">{count}</span>}
    </button>
  );
}

const linkify = (text: string) => text.split(/(https?:\/\/\S+)/g).map((part, i) => (/^https?:\/\//.test(part) ? <a key={i} href={part} onClick={(e) => { e.preventDefault(); openLink(part); }}>{part}</a> : part));
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1e6 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`);
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "long" });

function MessageList({ list, me, bus }: { list: Pending[]; me: Device; bus: Bus }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [list.length]);
  if (!list.length) return <div className="messages empty muted">Henüz mesaj yok. İlk mesajı siz yazın.</div>;
  let lastDay = "";
  return (
    <div className="messages">
      {list.map((m) => {
        const d = day(m.ts);
        const sep = d !== lastDay ? (lastDay = d) : null;
        if (m.system) return <div key={m.id}>{sep && <div className="day">{sep}</div>}<div className="system">{m.text}</div></div>;
        const mine = m.from === me.id;
        return (
          <div key={m.id}>
            {sep && <div className="day">{sep}</div>}
            <div className={`msg ${mine ? "mine" : ""} ${m.pending ? "pending" : ""} ${m.failed ? "failed" : ""}`}>
              {!mine && <div className="who">{m.fromNick}<span className="muted">#{m.from}</span></div>}
              {m.text && <div className="text">{linkify(m.text)}</div>}
              {m.files?.map((f, i) => <Attachment key={`${i}-${f.name}`} file={f} bus={bus} />)}
              <div className="meta">{m.failed ? "gönderilemedi" : m.pending ? "gönderiliyor…" : time(m.ts)}</div>
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

function Composer({ onSend }: { onSend: (text: string, files: File[]) => void }) {
  const [text, setText] = useState("");
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
      {files.length > 0 && <div className="chips">{files.map((f, i) => <span key={i} className="chip">📎 {f.name}<button onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}</div>}
      <div className="compose-row">
        <button className="icon" title="Dosya ekle" onClick={() => input.current?.click()}>＋</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
        <textarea rows={1} value={text} placeholder="Mesaj yazın" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !native()) { e.preventDefault(); submit(); } }} />
        <button className="primary send" onClick={submit} disabled={!text.trim() && !files.length}>Gönder</button>
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

function Settings({ session, me, bus, onMe, onClose, onSignOut }: { session: Session; me: Device; bus: Bus; onMe: (d: Device) => void; onClose: () => void; onSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
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
        <div className="actions spread">
          {session.source === "app" && <button className="ghost danger" onClick={onSignOut}>Çıkış yap</button>}
          <button className="ghost" onClick={onClose}>Kapat</button>
        </div>
      </div>
    </div>
  );
}
