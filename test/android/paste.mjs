// Pasting a copied image on an emulator, in a chat against the in-memory GitHub: the page's requests are caught
// through Chrome DevTools (api.github.com goes to the fake, anything else fails), so nothing leaves the machine.
// The image is copied in Chrome, from a page this test serves, as a person would copy one in another app (an image
// copied in the app's own WebView never reaches Android's clipboard). Install the debug APK, open Chrome once past
// its first-run screens, then:
//   node test/android/paste.mjs
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fakeGitHub } from "../fakegh.mjs";
import { Bus, dmChannel } from "../../core/src/index.ts";
import { setUpKeys } from "../../core/src/e2e.ts";
const ADB = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`;
const PKG = "com.egebulut.opencommunicate";
const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8", stdio: "pipe" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };

const REPO = "ege/team-chat";
const ege = { id: "7779", nick: "ege-bulut", kind: "person", login: "ege", joinedAt: "2026-10-01T00:00:00.000Z" };
const agent = { id: "2082", nick: "claude-oc", kind: "agent", login: "ege", joinedAt: "2026-10-01T00:00:00.000Z" };
const dm = dmChannel(ege.id, agent.id);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const server = http.createServer((req, res) => { res.writeHead(200, { "Content-Type": req.url === "/red.png" ? "image/png" : "text/html" }); res.end(req.url === "/red.png" ? PNG : "<img src=red.png>"); }).listen(8765, "127.0.0.1");
const gh = fakeGitHub();
const bus = new Bus({ repo: REPO, token: "t", fetch: gh.fetch });
await bus.commit({
  "opencommunicate.json": JSON.stringify({ protocol: 1, name: "team-chat", createdAt: "2026-10-01T00:00:00.000Z" }),
  "devices/7779.json": JSON.stringify(ege), "devices/2082.json": JSON.stringify(agent), "channels/all/.keep": "",
}, "setup");
bus.keys = setUpKeys(bus, agent.id, { stored: null, save: () => {}, members: (ch) => bus.membersOf(ch) });
await bus.keys;

// the app with nothing stored; its background check gets an address that leads nowhere
adb("shell", "pm", "clear", PKG);
execFileSync(ADB, ["shell", `run-as ${PKG} sh -c 'mkdir -p files && cat > files/oc-dev-api.txt'`], { input: "http://127.0.0.1:9" });
adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
let pid = "";
for (let i = 0; i < 40 && !pid; i++) { await sleep(250); try { pid = adb("shell", "pidof", PKG); } catch { /* not yet */ } }
await sleep(1500);
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
let page;
for (let i = 0; i < 40 && !page; i++) { try { page = (await (await fetch("http://127.0.0.1:9333/json")).json()).find((p) => p.type === "page"); } catch { await sleep(250); } } // the WebView's DevTools come up with the page
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let next = 1;
const waiting = new Map();
const send = (method, params = {}) => new Promise((r) => { const id = next++; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  .then((m) => m.result?.exceptionDetails ? { error: m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text } : m.result?.result?.value);
const outside = [], calls = [];
ws.addEventListener("message", async (e) => {
  const m = JSON.parse(e.data);
  if (m.id) return waiting.get(m.id)?.(m);
  if (m.method !== "Fetch.requestPaused") return;
  const { requestId, request } = m.params;
  const u = new URL(request.url);
  if (u.hostname === "localhost") return send("Fetch.continueRequest", { requestId });
  if (u.hostname !== "api.github.com") { outside.push(request.url); return send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); }
  const cors = [{ name: "access-control-allow-origin", value: "*" }, { name: "access-control-expose-headers", value: "etag" }];
  if (request.method === "OPTIONS") return send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: [...cors, { name: "access-control-allow-methods", value: "GET, POST, PATCH, PUT, DELETE" }, { name: "access-control-allow-headers", value: Object.entries(request.headers).find(([k]) => k.toLowerCase() === "access-control-request-headers")?.[1] ?? "*" }] });
  const body = request.postDataEntries ? Buffer.concat(request.postDataEntries.map((p) => Buffer.from(p.bytes ?? "", "base64"))).toString() : request.postData ?? "";
  const r = await gh.handle(request.method, request.url, Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])), body);
  calls.push(`${request.method} ${u.pathname}${u.search} ${body.length} -> ${r.status}`);
  send("Fetch.fulfillRequest", { requestId, responseCode: r.status, responseHeaders: [...Object.entries(r.headers ?? {}).map(([name, value]) => ({ name, value: String(value) })), ...cors], body: Buffer.from(r.body ?? "").toString("base64") });
});
await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

try {
  // signed in to the fake chat, then the page again
  const session = { repo: REPO, token: "t", device: ege, source: "app", account: "ege" };
  await run(`localStorage.setItem("oc.chats", ${JSON.stringify(JSON.stringify({ chats: [session], active: REPO, savedAt: Date.now() }))}); localStorage.setItem("oc.auth", ${JSON.stringify(JSON.stringify({ ege: { token: "t", at: Date.now() } }))}); location.reload(); 1`);
  for (let i = 0; i < 100 && !gh.files("keys")?.["keys/7779.json"]; i++) await sleep(200);
  await sleep(1000);
  const shown = `document.querySelector(".layout.view-chat .composer textarea")?.getBoundingClientRect().width > 0`;
  for (let i = 0; i < 40 && !(await run(shown)); i++) { await run(`[...document.querySelectorAll("button.row")].find((b) => b.textContent.includes("claude-oc"))?.click(); 1`); await sleep(250); }
  check("the DM is open", await run(shown));

  // Chrome in front copies the image (with a user gesture, through its own DevTools), then the app comes back
  const copyInChrome = async () => {
    adb("reverse", "tcp:8765", "tcp:8765");
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "http://localhost:8765/", "com.android.chrome");
    await sleep(3000);
    adb("forward", "tcp:9334", "localabstract:chrome_devtools_remote");
    const tab = (await (await fetch("http://127.0.0.1:9334/json")).json()).find((p) => p.type === "page" && p.url.startsWith("http://localhost:8765"));
    const cws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((r) => cws.addEventListener("open", r, { once: true }));
    const done = new Promise((r) => cws.addEventListener("message", (e) => r(JSON.parse(e.data).result?.result?.value)));
    cws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { awaitPromise: true, returnByValue: true, userGesture: true, expression: `fetch("red.png").then((r) => r.blob()).then((b) => navigator.clipboard.write([new ClipboardItem({ "image/png": b })])).then(() => "copied")` } }));
    const said = await done;
    cws.close();
    adb("forward", "--remove", "tcp:9334");
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"); // as its icon would
    await sleep(1500);
    return said;
  };
  const chips = () => run(`[...document.querySelectorAll(".composer .chip")].map((c) => c.textContent)`);
  check("the plugin sees no image while the clipboard holds text", await run(`navigator.clipboard.writeText("hello").then(() => Capacitor.Plugins.ClipboardImage.has()).then((r) => r.image === false)`));
  check("Chrome copies the image", (await copyInChrome()) === "copied");
  check("back in the app, the chat is still open", await run(shown));
  check("…and the plugin sees it", await run(`Capacitor.Plugins.ClipboardImage.has().then((r) => r.image)`));
  await run(`document.querySelector(".attach-btn").click(); 1`);
  await sleep(500);
  const bar = await run(`[...document.querySelectorAll(".composer .reply-bar")].map((b) => b.textContent).join("|")`);
  check("📎 offers to paste the copied image", /You copied an image.*Paste it.*Choose a file/.test(bar), bar);
  await run(`[...document.querySelectorAll(".composer .reply-bar button")].find((b) => b.textContent === "Paste it").click(); 1`);
  await sleep(1000);
  check("Paste it adds the image, with a name of its own", /^📎 image-\d{14}\.png/.test((await chips())[0] ?? ""), JSON.stringify(await chips()));
  check("and the offer is gone", !(await run(`[...document.querySelectorAll(".composer .reply-bar")].some((b) => b.textContent.includes("copied"))`)));

  // a keyboard's paste (Ctrl+V) in the box goes through the page's own paste handling (the box is focused from the
  // page: Android's preview of what was copied sits over the bottom of the screen for a while)
  await run(`document.querySelector(".composer textarea").focus(); 1`);
  await sleep(500);
  adb("shell", "input", "keycombination", "113", "50");
  await sleep(1500);
  check("Ctrl+V in the box adds it too", (await chips()).length === 2 && /^📎 image-\d{14}(-\d)?\.png/.test((await chips())[1] ?? ""), JSON.stringify(await chips()));

  await run(`document.querySelector(".composer .send").click(); 1`);
  let sent;
  for (let i = 0; i < 60 && !sent; i++) { await sleep(500); sent = (await bus.history(dm)).find((m) => m.from === ege.id && m.files?.length); }
  check("both are sent", sent?.files?.length === 2 && sent.files.every((f) => /^image-\d{14}(-\d)?\.png$/.test(f.name)), JSON.stringify(sent?.files?.map((f) => f.name)));
  const bytes = sent && (await bus.fileOf(sent.files[0]).catch((e) => e));
  // Chrome copies the image decoded and written again as a PNG of its own: the same 1×1 image, not the same bytes
  const png = bytes instanceof Uint8Array && Buffer.from(bytes);
  check("the image arrives whole", png && png.subarray(0, 8).equals(PNG.subarray(0, 8)) && png.readUInt32BE(16) === 1 && png.readUInt32BE(20) === 1, String(bytes?.length ?? bytes));
  check("nothing went past the fake", outside.length === 0, outside.join(" "));
} finally {
  ws.close();
  server.close();
  adb("forward", "--remove", "tcp:9333");
  adb("reverse", "--remove", "tcp:8765");
  adb("shell", "pm", "clear", PKG); // no test chat left behind
}
console.log(`${results.filter(Boolean).length}/${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
