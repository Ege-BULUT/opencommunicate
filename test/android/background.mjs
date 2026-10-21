// Android's background check (MessageCheck) on an emulator, against the fake GitHub on the host:
//   node test/android/background.mjs <apk>
// The APK must allow cleartext HTTP to reach the fake (a test build only, never released: add
// android:usesCleartextTraffic="true" to <application> in AndroidManifest.xml, assembleDebug, revert). The job reads
// oc-dev-api.txt for the API address. Launch the app only with no chat stored, as here: with one, its page would
// call the real GitHub.
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fakeGitHub } from "../fakegh.mjs";
import { Bus, dmChannel } from "../../core/src/index.ts";
const ADB = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const PKG = "com.egebulut.opencommunicate";
const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };

const gh = fakeGitHub();
const bus = new Bus({ repo: "ege/team-chat", token: "agent", fetch: gh.fetch });
const ege = { id: "7779", nick: "ege-bulut", kind: "person", login: "ege", joinedAt: "2026-10-01T00:00:00.000Z", quiet: { all: { mode: "off" } } };
const agent = { id: "2082", nick: "claude-oc", kind: "agent", login: "ege", joinedAt: "2026-10-01T00:00:00.000Z" };
const other = { id: "3333", nick: "bob", kind: "person", login: "bob", joinedAt: "2026-10-01T00:00:00.000Z" };
await bus.commit({ "opencommunicate.json": "{}", "devices/7779.json": JSON.stringify(ege), "devices/2082.json": JSON.stringify(agent), "devices/3333.json": JSON.stringify(other), "channels/all/.keep": "" }, "setup");
const team = await bus.createGroup("Team", ["7779"], agent);
const secret = await bus.createGroup("Secret", ["3333"], agent);
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", async () => {
    const r = await gh.handle(req.method, `https://api.github.com${req.url}`, req.headers, body);
    res.writeHead(r.status, r.headers); res.end(r.body);
  });
}).listen(4999, "127.0.0.1");

adb("install", "-r", process.argv[2]);
adb("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS");
// open once with no chat stored (schedules the job; the page makes no GitHub call before sign-in), then kill it
adb("shell", "pm", "clear", PKG);
adb("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS");
adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
await sleep(6000);
adb("shell", "input", "keyevent", "HOME");
await sleep(1500);
const kill = () => { try { const pid = adb("shell", "pidof", PKG).trim(); if (pid) adb("shell", `run-as ${PKG} kill -9 ${pid}`); } catch { /* not running */ } };
kill(); // like Android ending a closed app: the job stays scheduled
const put = (name, text) => execFileSync(ADB, ["shell", `run-as ${PKG} sh -c 'mkdir -p files && cat > files/${name}'`], { input: text });
const get = (name) => { try { return adb("shell", "run-as", PKG, "cat", `files/${name}`); } catch { return ""; } };
const now = Date.now();
put("oc-dev-api.txt", "http://10.0.2.2:4999");
put("oc-session.json", JSON.stringify({ chats: [{ repo: "ege/team-chat", token: "old", device: ege, source: "app", account: "ege" }], active: "ege/team-chat", savedAt: now }));
put("oc-auth.json", JSON.stringify({ ege: { token: "t1", refresh: "r1", expiresAt: now - 60_000, refreshExpiresAt: now + 1e9, at: now - 8 * 3600e3 }, bob: { token: "b1", at: 5 } }));
check("job scheduled", /7001/.test(adb("shell", "dumpsys", "jobscheduler", PKG)));
const run = async () => { kill(); await sleep(500); adb("shell", "cmd", "jobscheduler", "run", "-f", PKG, "7001"); await sleep(8000); };
const notices = () => adb("shell", "dumpsys", "notification", "--noredact").split("\n").filter((l) => /android.text=|android.title=/.test(l) && /String/.test(l)).map((l) => l.trim());

try { adb("shell", "cmd", "notification", "cancel_all"); } catch { /* not on every image */ }
await run();
const auth = JSON.parse(get("oc-auth.json") || "{}"), bg = JSON.parse(get("oc-auth-bg.json") || "{}");
check("an expired token is renewed into the job's own file", gh.refreshes.length === 1 && bg.ege?.token === "t2" && bg.ege?.refresh === "r2" && bg.ege.at > now, JSON.stringify(bg.ege));
check("the page's file is not touched", auth.ege?.token === "t1" && auth.bob?.token === "b1");
check("no renewing marker left", get("oc-renewing.json") === "");
check("calls use the new token", gh.tokens.has("t2") && !gh.tokens.has("t1"));
check("first run records the head, notifies nothing", !!JSON.parse(get("oc-bg.json") || "{}")["ege/team-chat"]?.head && !notices().some((l) => /claude-oc/.test(l)));

await bus.send(dmChannel(ege.id, agent.id), agent, "DM while the app is closed");
await bus.send(team.channel, agent, "Team news");
await bus.send(secret.channel, agent, "not for ege");
await bus.send("all", agent, "#all is muted for ege");
await bus.send(team.channel, ege, "my own message");
const toEdit = await bus.send(team.channel, agent, "before the edit");
await run();
const shown = notices().join("\n");
check("a DM is notified", shown.includes("DM while the app is closed"), "");
check("a group message is notified", shown.includes("Team news"));
check("another group's message is not", !shown.includes("not for ege"));
check("a muted channel is not", !shown.includes("#all is muted"));
check("my own message is not", !shown.includes("my own message"));
check("title is nick#id", shown.includes("claude-oc#2082"));
const before = (shown.match(/DM while the app is closed/g) ?? []).length;
await bus.amend(agent, toEdit, "after the edit");
await run();
check("an edit is not notified again", (notices().join("\n").match(/before the edit|after the edit/g) ?? []).length === 1);
// the page noted a newer head (it notified up to there): the next run starts from it
await bus.send(dmChannel(ege.id, agent.id), agent, "seen by the page");
put("oc-heads.json", JSON.stringify({ "ege/team-chat": { head: gh.ref("main", "ege/team-chat"), at: Date.now() } }));
await run();
const later = notices().join("\n");
check("nothing is notified twice", (later.match(/DM while the app is closed/g) ?? []).length === before);
check("what the page already notified is not notified again", !later.includes("seen by the page"));
check("no second renewal", gh.refreshes.length === 1);
// the page alive (app in the background): no renewal (the page renews), its open chat left to it, others notified
const bus2 = new Bus({ repo: "ege/other-chat", token: "agent", fetch: gh.fetch });
await bus2.commit({ "opencommunicate.json": "{}", "devices/7779.json": JSON.stringify({ ...ege, quiet: undefined }), "devices/2082.json": JSON.stringify(agent), "channels/all/.keep": "" }, "setup");
kill();
adb("shell", "pm", "clear", PKG); // no chat stored while the page starts, so it calls no real GitHub
adb("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS");
adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
await sleep(6000);
adb("shell", "input", "keyevent", "HOME");
const t = Date.now();
put("oc-dev-api.txt", "http://10.0.2.2:4999");
const bus3 = new Bus({ repo: "ege/third-chat", token: "agent", fetch: gh.fetch });
await bus3.commit({ "opencommunicate.json": "{}", "devices/7779.json": JSON.stringify({ ...ege, quiet: undefined }), "devices/2082.json": JSON.stringify(agent), "channels/all/.keep": "" }, "setup");
put("oc-session.json", JSON.stringify({ chats: [["team", "ege"], ["other", "ege2"], ["third", "ege3"]].map(([r, a]) => ({ repo: `ege/${r}-chat`, token: "x", device: ege, source: "app", account: a })), active: "ege/team-chat", savedAt: t }));
put("oc-auth.json", JSON.stringify({ ege: { token: "t2", expiresAt: t + 3600e3, at: t }, ege2: { token: "u1", expiresAt: t + 3600e3, at: t }, ege3: { token: "v1", refresh: "r2", expiresAt: t - 1000, at: t } }));
put("oc-bg.json", JSON.stringify(Object.fromEntries(["team", "other", "third"].map((r) => [`ege/${r}-chat`, { head: gh.ref("main", `ege/${r}-chat`), at: t }]))));
await bus.send(dmChannel(ege.id, agent.id), agent, "open chat, page alive");
await bus2.send(dmChannel(ege.id, agent.id), agent, "other chat, page alive");
await bus3.send(dmChannel(ege.id, agent.id), agent, "third chat, token ran out");
const n0 = gh.refreshes.length;
adb("shell", "cmd", "jobscheduler", "run", "-f", PKG, "7001");
await sleep(30000); // the job waits 20 s for the page first
const alive = notices().join("\n");
check("page alive: no renewal", gh.refreshes.length === n0);
check("page alive: its open chat is left to it", !alive.includes("open chat, page alive"));
const auth2 = JSON.parse(get("oc-auth.json") || "{}");
check("page alive: another chat is notified", alive.includes("other chat, page alive"));
check("page alive: an expired token is not renewed or used", auth2.ege3?.token === "v1" && !get("oc-auth-bg.json").includes("ege3") && !alive.includes("third chat, token ran out"));
check("page alive: the open chat's head is left to the page", JSON.parse(get("oc-bg.json") || "{}")["ege/team-chat"]?.at === t);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
