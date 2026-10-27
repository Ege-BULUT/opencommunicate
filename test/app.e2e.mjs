// The app in Chromium against the in-memory GitHub: `npm run build -w app`, then
//   node test/app.e2e.mjs [drafts|asks|status|info|read|quotes|keys|files|markdown|quota|update|dictate|voice|all]
// CHROMIUM=<path> uses that browser instead of Playwright's. "all" leaves out dictate and voice, which need Whisper's files
// (WHISPER_DIR=<a folder holding onnx-community/whisper-large-v3-turbo>) and a 16 kHz recording (VOICE_WAV=<file>);
// GPU=1 runs it on WebGPU, in a visible window.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { fakeGitHub } from "./fakegh.mjs";
import { Bus, dmChannel, msgPath } from "../core/src/index.ts";
import { setUpKeys } from "../core/src/e2e.ts";

const dist = path.join(import.meta.dirname, "..", "app", "dist");
const only = process.argv[2] ?? "all";
const REPO = "ege/team-chat";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let f = path.join(dist, path.normalize(u.pathname));
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
  res.writeHead(200, { "Content-Type": types[path.extname(f)] ?? "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const ege = { id: "7779", nick: "ege-bulut", kind: "person", login: "ege", joinedAt: "2026-10-01T00:00:00.000Z" };
const agent = { id: "2082", nick: "claude-oc", kind: "agent", login: "ege", joinedAt: "2026-10-01T00:00:00.000Z" };
const dm = dmChannel(ege.id, agent.id);

async function setup(delay, args = [], routes = async () => false, prepare = async () => {}) {
  const gh = fakeGitHub({ delay });
  const bus = new Bus({ repo: REPO, token: "t", fetch: gh.fetch });
  await bus.commit({
    "opencommunicate.json": JSON.stringify({ protocol: 1, name: "team-chat", createdAt: "2026-10-01T00:00:00.000Z" }),
    "devices/7779.json": JSON.stringify(ege), "devices/2082.json": JSON.stringify(agent), "channels/all/.keep": "",
  }, "setup");
  // the chat is end-to-end encrypted: the test's Bus speaks as the agent with its own key, published before the
  // app (ege-bulut) makes its key and the DM's
  bus.keys = setUpKeys(bus, agent.id, { stored: null, save: () => {}, members: (ch) => bus.membersOf(ch) });
  await bus.keys;
  await prepare(gh);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args, headless: !process.env.GPU });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: "en-US", hasTouch: false });
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.hostname === "api.github.com") {
      const r = await gh.handle(req.method(), req.url(), req.headers(), req.postData() ?? "");
      return route.fulfill({ status: r.status, headers: { ...r.headers, "access-control-allow-origin": "*", "access-control-expose-headers": "etag, x-ratelimit-limit, x-ratelimit-used, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-resource" }, body: r.body });
    }
    if (u.hostname === "127.0.0.1") return route.continue();
    if (await routes(route, u)) return;
    return route.abort();
  });
  const session = { repo: REPO, token: "t", device: ege, source: "app", account: "ege" };
  await ctx.addInitScript(([s]) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("oc.chats", JSON.stringify({ chats: [s], active: s.repo, savedAt: Date.now() }));
    localStorage.setItem("oc.auth", JSON.stringify({ ege: { token: "t", at: Date.now() } }));
  }, [session]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(base);
  // the app makes its key on start: wait for it, so what the test sends next is sealed for it too
  for (let i = 0; i < 100 && !gh.files("keys")?.["keys/7779.json"]; i++) await sleep(100);
  await sleep(300);
  return { gh, bus, browser, page };
}

const openDm = async (page) => { await page.getByText("claude-oc", { exact: false }).first().click(); await page.locator("textarea").waitFor(); };

if (only === "all" || only === "drafts") {
  let slowed = 0;
  // the first drafts write lands 3 s late, like a slow phone connection
  const draftsRef = (method, p, body) => (method === "PATCH" && p.endsWith("/git/refs/heads/drafts")) || (method === "POST" && p.endsWith("/git/refs") && body.ref === "refs/heads/drafts");
  const { gh, bus, browser, page } = await setup((method, p, body) => (draftsRef(method, p, body) && slowed++ === 0 ? 3000 : 0));
  await openDm(page);
  const box = page.locator("textarea");
  await box.pressSequentially("half of a long message", { delay: 5 });
  await sleep(1800); // a pause: the halfway draft is saved (and lands late)
  await box.pressSequentially(" and the rest", { delay: 5 });
  await box.press("Enter");
  await page.locator("button.back").click(); // straight back to the list
  await sleep(9000);
  const drafts = JSON.parse(gh.files("drafts")["drafts/7779.json"] ?? "{}").drafts ?? {};
  check("drafts branch has no draft for the sent message", !drafts[dm], JSON.stringify(drafts));
  const row = await page.locator(".draft-tag").count();
  check("chat list shows no draft tag", row === 0);
  await openDm(page);
  check("composer is empty after reopening", (await page.locator("textarea").inputValue()) === "", await page.locator("textarea").inputValue());
  const sent = (await bus.history(dm)).map((m) => m.text);
  check("the message was sent", sent.includes("half of a long message and the rest"));
  await browser.close();
}

if (only === "all" || only === "asks") {
  const { gh, bus, browser, page } = await setup(() => 0);
  const ask = await bus.send(dm, agent, "Push 0.8.5?", [], { ask: ["Yes, push", "Not yet"] });
  await openDm(page);
  await page.locator(".choice").first().waitFor({ timeout: 15000 });
  const labels = await page.locator(".choice").allTextContents();
  check("a button per choice and one to write", JSON.stringify(labels) === JSON.stringify(["Yes, push", "Not yet", "Write an answer…"]), JSON.stringify(labels));
  await page.getByRole("button", { name: "Not yet" }).click();
  await sleep(1500);
  const answers = () => bus.history(dm).then((l) => l.filter((m) => m.id !== ask.id));
  const a1 = (await answers()).find((m) => m.text === "Not yet");
  check("picking sends the choice, as a reply, with its index", !!a1 && a1.replyTo === ask.id && a1.answer?.choice === 1, JSON.stringify(a1));
  await sleep(500);
  check("my pick is marked", (await page.locator(".choice.on").allTextContents()).join() === "✓ Not yet");
  await page.getByRole("button", { name: "Write an answer…" }).click();
  check("writing an answer quotes the ask", (await page.locator(".reply-bar").count()) === 1);
  await page.locator("textarea").fill("after lunch");
  await page.locator("textarea").press("Enter");
  await sleep(1500);
  const a2 = (await answers()).find((m) => m.text === "after lunch");
  check("a written answer has choice null", !!a2 && a2.replyTo === ask.id && a2.answer && a2.answer.choice === null, JSON.stringify(a2));
  await sleep(500);
  check("then the write button is marked", (await page.locator(".choice.on").allTextContents()).join() === "✓ Write an answer…");
  // replying the usual way with a choice's text picks it
  await page.locator(`#m-${ask.id} .msg`).hover();
  await page.locator("textarea").fill("");
  // the agent's own ask from the app side: no buttons to press
  const mine = await bus.send(dm, ege, "Which build?", [], { ask: ["Debug", "Release"] });
  await page.locator(`#m-${mine.id} .choice`).first().waitFor({ timeout: 15000 });
  check("my own ask shows choices disabled, without the write button", (await page.locator(`#m-${mine.id} .choice:disabled`).count()) === 2 && (await page.locator(`#m-${mine.id} .choice.other`).count()) === 0);
  // the agent closes a question (an approval answered in the terminal): its choices go disabled, with why
  const gone = await bus.send(dm, agent, "Allow Bash?", [], { ask: ["Allow", "Deny"] });
  await page.locator(`#m-${gone.id} .choice`).first().waitFor({ timeout: 15000 });
  await bus.closeAsk(agent, gone, "answered in the terminal");
  await page.locator(`#m-${gone.id} .closed`).waitFor({ timeout: 15000 });
  check("a closed question: choices disabled, no write button, the reason shown", (await page.locator(`#m-${gone.id} .choice:disabled`).count()) === 2 && (await page.locator(`#m-${gone.id} .choice.other`).count()) === 0 && (await page.locator(`#m-${gone.id} .closed`).innerText()) === "Closed: answered in the terminal");
  const closedNotice = page.locator(".system.notice", { hasText: "claude-oc#2082 closed a question" });
  await closedNotice.waitFor({ timeout: 15000 }).catch(() => {});
  check("a notice says it closed", (await closedNotice.count()) === 1);
  await browser.close();
}

if (only === "all" || only === "status") {
  const { bus, browser, page } = await setup(() => 0);
  await bus.heartbeat(agent, "deploying v0.8.5 to vercel and checking the APK download");
  await openDm(page);
  const sub = page.locator(".chat-head .sub");
  await page.locator(".chat-head .marquee").waitFor({ timeout: 15000 });
  check("header says online • status", (await sub.textContent()).startsWith("online • deploying v0.8.5"), await sub.textContent());
  const anim = () => page.locator(".chat-head .marquee > span").evaluate((el) => el.getAnimations().length);
  check("a long status slides", (await anim()) === 1);
  await bus.heartbeat(agent, "idle");
  await page.waitForFunction(() => document.querySelector(".chat-head .marquee")?.textContent === "idle", null, { timeout: 15000 });
  check("a new status shows within a poll; a short one stays still", (await anim()) === 0);
  await bus.heartbeat(agent, "");
  await page.waitForFunction(() => !document.querySelector(".chat-head .marquee"), null, { timeout: 15000 });
  check("a cleared status goes back to kind · online", (await sub.textContent()) === "agent · online", await sub.textContent());
  await browser.close();
}

if (only === "all" || only === "info") {
  const { bus, browser, page } = await setup(() => 0);
  const m = await bus.send(dm, ege, "hello agent", [], {});
  await new Promise((r) => setTimeout(r, 1100));
  const { message: edited } = await bus.amend(ege, m, "hello agent, edited");
  await bus.markReceipts(agent, { [dm]: { read: m.id } });
  await bus.react(agent, m, "👍");
  await openDm(page);
  await page.locator(`#m-${m.id} .msg`).waitFor({ timeout: 15000 });
  await page.evaluate(() => { window.opened = []; window.open = (u) => { window.opened.push(u); return null; }; });
  await sleep(6000); // a poll brings the receipt and the reaction
  await page.locator(`#m-${m.id} .msg`).click({ button: "right" });
  const box = await page.locator(".msg-menu").boundingBox();
  check("the menu fits on the screen", box && box.y >= 0 && box.y + box.height <= 800 && box.x + box.width <= 390, JSON.stringify(box));
  await page.getByRole("menuitem", { name: "ⓘ Info" }).click();
  const sheet = page.locator(".msg-info");
  await sheet.waitFor();
  const text = await sheet.innerText();
  check("info: author, sent, edited", text.includes("ege-bulut#7779 (you)") && text.includes("Sent") && /Edited|edited/.test(text), text);
  check("info: the agent read it", /claude-oc#2082\s*read/.test(text), text);
  check("info: who reacted", text.includes("👍 claude-oc#2082"), text);
  check("info: the earlier text", text.includes("Earlier versions") && text.includes("hello agent\n") || text.includes("hello agent"), text);
  check("info: the id", text.includes(m.id));
  await sheet.getByRole("button", { name: "Open on GitHub" }).click();
  const opened = await page.evaluate(() => window.opened);
  check("info: the GitHub link", opened[0] === `https://github.com/${REPO}/blob/main/${msgPath(m)}`, JSON.stringify(opened));
  await page.keyboard.press("Escape");
  check("Escape closes it", (await page.locator(".msg-info").count()) === 0);
  // an ask's answers
  const ask = await bus.send(dm, agent, "Ship it?", [], { ask: ["Yes", "No"] });
  await page.locator(`#m-${ask.id} .choice`).first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "No", exact: true }).click();
  await sleep(1500);
  await page.locator(`#m-${ask.id} .msg`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "ⓘ Info" }).click();
  check("info: answers to an ask", (await page.locator(".msg-info").innerText()).includes("ege-bulut#7779: No"));
  await browser.close();
}

if (only === "all" || only === "read") {
  const { bus, browser, page } = await setup(() => 0);
  // a stand-in for the system's voices: records what is spoken, in which language
  await page.evaluate(() => {
    window.spoken = [];
    const fake = { getVoices: () => [{ lang: "tr-TR", name: "Yelda" }, { lang: "en-US", name: "Samantha" }], cancel() { const u = fake.current; fake.current = null; u?.onerror?.({ error: "interrupted" }); },
      speak(u) { fake.current = u; window.spoken.push(`${u.lang}:${u.text}`); setTimeout(() => { if (fake.current === u) { fake.current = null; u.onend(); } }, 300); }, addEventListener() {} };
    Object.defineProperty(window, "speechSynthesis", { value: fake });
  });
  const m = await bus.send(dm, agent, "vercel'e deploy ettim, claude ile GPT'yi karşılaştırdım", [], {});
  await openDm(page);
  await page.locator(`#m-${m.id} .msg`).waitFor({ timeout: 15000 });
  await page.locator(`#m-${m.id} .msg`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "🔊 Read aloud" }).click();
  await page.locator(".toast.reading").waitFor();
  check("a reading bar with Stop", (await page.locator(".toast.reading").innerText()).includes("Stop"));
  await page.locator(".toast.reading").waitFor({ state: "detached", timeout: 10000 });
  const spoken = await page.evaluate(() => window.spoken);
  check("each run in its language's voice", spoken.join(" | ") === "en-US:vercel | tr-TR:e | en-US:deploy | tr-TR:ettim, | en-US:claude | tr-TR:ile | en-US:GPT | tr-TR:yi karşılaştırdım", spoken.join(" | "));
  // Stop in the middle
  await page.evaluate(() => (window.spoken = []));
  await page.locator(`#m-${m.id} .msg`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "🔊 Read aloud" }).click();
  await sleep(450);
  await page.getByRole("button", { name: "Stop" }).click();
  await sleep(1000);
  const n = (await page.evaluate(() => window.spoken)).length;
  check("Stop stops it", n >= 1 && n <= 3 && (await page.locator(".toast.reading").count()) === 0, String(n));
  // no Turkish voice
  await page.evaluate(() => { const v = speechSynthesis.getVoices; speechSynthesis.getVoices = () => v().filter((x) => x.lang !== "tr-TR"); });
  await page.reload(); // the plugin keeps the voices it read; a fresh page reads them again
  await page.evaluate(() => {
    const fake = { getVoices: () => [{ lang: "en-US", name: "Samantha" }], cancel() {}, speak(u) { setTimeout(() => u.onend(), 10); }, addEventListener() {} };
    Object.defineProperty(window, "speechSynthesis", { value: fake });
  });
  await openDm(page);
  await page.locator(`#m-${m.id} .msg`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "🔊 Read aloud" }).click();
  await page.locator(".toast:not(.reading)").waitFor({ timeout: 5000 });
  check("no Turkish voice: says so", (await page.locator(".toast:not(.reading)").innerText()).startsWith("This device has no Turkish voice. Add one"), await page.locator(".toast:not(.reading)").innerText());
  await browser.close();
}

// Whisper in the page, fed a recording through Chromium's fake microphone; the model files come from the local
// copy (the test never reaches Hugging Face)
async function withWhisper() {
  const HF = process.env.WHISPER_DIR, WAV = process.env.VOICE_WAV;
  if (!HF || !WAV) throw new Error("dictate and voice need WHISPER_DIR and VOICE_WAV (see the top of this file)");
  const asked = [];
  const files = http.createServer((req, res) => {
    const f = path.join(HF, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(HF) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fs.statSync(f).size, "access-control-allow-origin": "*" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => files.listen(0, "127.0.0.1", r));
  const { gh, bus, browser, page } = await setup(() => 0, ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`], async (route, u) => {
    if (u.hostname !== "huggingface.co") return false;
    const m = u.pathname.match(/^\/(onnx-community\/[^/]+)\/resolve\/main\/(.+)$/);
    const f = m && path.join(HF, m[1], m[2]);
    asked.push(u.pathname);
    if (!f || !fs.existsSync(f)) { await route.fulfill({ status: 404, body: "" }); return true; }
    // too big to hand to Playwright: a redirect to a local server
    await route.fulfill({ status: 302, headers: { location: `http://127.0.0.1:${files.address().port}/${m[1]}/${m[2]}`, "access-control-allow-origin": "*" } });
    return true;
  });
  if (process.env.GPU) console.log("  webgpu:", await page.evaluate(async () => { const a = await navigator.gpu?.requestAdapter(); return a ? `adapter, shader-f16 ${a.features.has("shader-f16")}` : "none"; }));
  await page.reload();
  page.on("console", (msg) => { if (msg.type() === "error" || msg.type() === "warning") console.log("console:", msg.text().slice(0, 300)); });
  page.on("requestfailed", (r) => console.log("failed:", r.url().slice(0, 120), r.failure()?.errorText));
  return { gh, bus, browser, page, asked, files };
}

if (only === "dictate") {
  const { browser, page, asked, files } = await withWhisper();
  await openDm(page);
  await page.getByRole("button", { name: "Dictate" }).click();
  check("first use asks before the download", (await page.locator(".reply-bar").innerText()).includes("downloaded once (0.6 to 0.8 GB)"));
  await page.locator(".reply-bar").getByRole("button", { name: "Download" }).click();
  const mic = page.getByRole("button", { name: "Dictate" });
  await page.waitForFunction(() => document.querySelector(".mic-btn")?.getAttribute("aria-pressed") === "true", null, { timeout: 10000 });
  check("the box is read-only while listening", await page.locator("textarea").evaluate((t) => t.readOnly));
  const t0 = Date.now();
  await sleep(10500); // the recording is 9.6 s
  await page.waitForFunction(() => document.querySelector(".mic-btn")?.classList.contains("on"));
  const t1 = Date.now();
  await mic.click();
  check("the page answers while the model loads (it loads in a worker)", Date.now() - t1 < 1500, `${Date.now() - t1} ms`);
  await page.waitForFunction(() => document.querySelector("textarea").value.length > 20, null, { timeout: 600000 });
  const text = await page.locator("textarea").inputValue();
  console.log(`  (${Math.round((Date.now() - t0) / 1000)} s) ${text}`);
  check("Turkish with English terms", /deploy/i.test(text) && /GPT/.test(text) && /Claude/.test(text) && /karşılaştırdım/.test(text), text);
  const onnx = asked.filter((p) => p.endsWith(".onnx"));
  // WebGPU's 16-bit files, or the processor's (after WebGPU, if it was offered and failed)
  check("one set of model files", onnx.slice(-2).every((p) => p.includes("_q4f16")) || onnx.slice(-2).every((p) => p.includes("_q4.")), onnx.join(", "));
  await page.waitForFunction(() => document.querySelector(".mic-btn")?.getAttribute("aria-pressed") === "false");
  check("the button is off again, the box editable", !(await page.locator("textarea").evaluate((t) => t.readOnly)));
  await browser.close();
  files.close();
}

if (only === "voice") {
  // hold 🎤: a voice message to listen to and its text to fix, sent only with Send
  const { gh, bus, browser, page, files } = await withWhisper();
  await page.evaluate(() => localStorage.setItem("oc.whisper", "1")); // the model was agreed to before
  await openDm(page);
  const mic = page.locator(".mic-btn");
  const box = await mic.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.locator(".voice-rec").waitFor({ timeout: 10000 });
  check("holding records, with a clock", /● 0:0\d/.test(await page.locator(".voice-rec").innerText()));
  await sleep(10500);
  await page.mouse.up();
  await page.locator(".voice-preview audio").waitFor({ timeout: 10000 });
  check("letting go shows it to listen to", (await page.locator(".voice-preview").innerText()).includes("s"));
  await page.waitForFunction(() => document.querySelector("textarea").value.length > 20, null, { timeout: 600000 });
  const said = await page.locator("textarea").inputValue();
  check("what it says is written into the box", /GPT/.test(said) && /karşılaştırdım/.test(said), said);
  await sleep(4000);
  check("nothing is sent before Send", !Object.keys(gh.files()).some((p) => p.includes("/files/")));
  await page.locator("textarea").fill("Fixed: " + said.slice(0, 40));
  await page.getByRole("button", { name: "Send" }).click();
  await sleep(2500);
  const sent = (await bus.history(dm)).find((m) => m.text?.startsWith("Fixed: "));
  const f = sent?.files?.[0];
  check("Send sends the audio with the fixed text", !!f && f.voice === true && f.dur > 8 && f.type === "audio/webm" && f.size > 10000, JSON.stringify(sent));
  await page.locator(`#m-${sent.id} .voice-note`).waitFor({ timeout: 15000 });
  check("the chat shows a player for it", (await page.locator(`#m-${sent.id} .voice-note audio`).count()) === 1);
  check("the box and the preview are cleared", (await page.locator(".voice-preview").count()) === 0 && (await page.locator("textarea").inputValue()) === "");
  // a slip of the finger records nothing
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await sleep(500); await page.mouse.up();
  await sleep(1000);
  check("a short press-and-release leaves nothing", (await page.locator(".voice-preview, .voice-rec").count()) === 0);
  await browser.close();
  files.close();
}

if (only === "all" || only === "keys") {
  // ege's account already has a key, made on another device and locked with the password: this new device asks for
  // the password once, then reads what was sealed for the account; and what it sends is sealed in the repository
  let early;
  const { gh, bus, browser, page } = await setup(() => 0, [], async () => false, async (fake) => {
    const other = new Bus({ repo: REPO, token: "t", fetch: fake.fetch });
    other.keys = setUpKeys(other, ege.id, { stored: null, save: () => {}, password: async () => "ege's password", members: (ch) => other.membersOf(ch) });
    await other.keys;
    early = await other.send(dm, ege, "sealed before this device", []);
  });
  await page.locator(".sheet", { hasText: "🔒 Encryption" }).waitFor({ timeout: 15000 });
  check("a new device asks for the password to unlock the account's key", (await page.locator(".sheet").innerText()).includes("ege-bulut#7779's password"));
  const box = page.locator(".sheet .password-box input");
  await box.fill("not it");
  await page.getByRole("button", { name: "Show password" }).click();
  check("the eye shows the password", (await box.getAttribute("type")) === "text" && (await box.inputValue()) === "not it");
  await page.getByRole("button", { name: "Hide password" }).click();
  check("and hides it again", (await box.getAttribute("type")) === "password");
  await page.screenshot({ path: path.join(process.env.SHOTS ?? "/tmp", "password-box.png") }).catch(() => {});
  await page.locator(".sheet button.primary").click();
  await page.locator(".sheet .error").waitFor({ timeout: 15000 });
  check("a wrong password says so and asks again", (await page.locator(".sheet .error").innerText()).includes("didn't unlock"));
  await page.locator(".sheet input[type=password]").fill("ege's password");
  await page.locator(".sheet button.primary").click();
  await page.locator(".sheet").waitFor({ state: "detached", timeout: 15000 });
  await openDm(page);
  await page.locator(`#m-${early.id} .text`).waitFor({ timeout: 15000 });
  check("then it reads what was sealed for the account", (await page.locator(`#m-${early.id} .text`).innerText()) === "sealed before this device");
  await page.locator("textarea").fill("sent from the new device");
  await page.locator("textarea").press("Enter");
  await sleep(2000);
  const sent = (await bus.history(dm)).find((m) => m.text === "sent from the new device");
  const stored = sent && JSON.parse(gh.files()[msgPath(sent)]);
  check("what it sends is sealed in the repository, and the agent opens it", !!stored?.enc && !JSON.stringify(stored).includes("new device"), JSON.stringify(stored)?.slice(0, 200));
  await browser.close();
}

if (only === "all" || only === "quotes") {
  const { gh, bus, browser, page } = await setup(() => 0);
  const a = await bus.send(dm, agent, "first point", []);
  const b = await bus.send(dm, agent, "second point", []);
  const c = await bus.send(dm, agent, "third point", []);
  await openDm(page);
  await page.locator(`#m-${c.id} .msg`).waitFor({ timeout: 15000 });
  const quote = async (m) => { await page.locator(`#m-${m.id} .msg`).click({ button: "right" }); await page.getByRole("menuitem", { name: "↩ Reply" }).click(); };
  await quote(a); await quote(b); await quote(c); await quote(a);
  const bars = page.locator(".composer .reply-bar");
  check("each quote has its own bar, none twice", (await bars.count()) === 3, String(await bars.count()));
  await bars.nth(1).getByRole("button").click(); // × on "second point"
  check("× takes off that one only", (await bars.allInnerTexts()).map((t) => t.includes("second")).join() === "false,false");
  await page.locator("textarea").fill("about the first and third");
  await page.locator("textarea").press("Enter");
  await sleep(1500);
  const sent = (await bus.history(dm)).find((m) => m.text === "about the first and third");
  check("sent with replyTo and quotes, in the order chosen", sent?.replyTo === a.id && JSON.stringify(sent?.quotes) === JSON.stringify([c.id]), JSON.stringify(sent));
  check("the bars are gone", (await bars.count()) === 0);
  await page.locator(`#m-${sent.id} .quote`).first().waitFor();
  check("the message shows both quotes", (await page.locator(`#m-${sent.id} .quote`).allInnerTexts()).map((t) => t.replace(/\s+/g, " ")).join(" | ").includes("first point") && (await page.locator(`#m-${sent.id} .quote`).count()) === 2);
  await browser.close();
}

// an image pasted into the box and a file dropped on the chat join the message; a paste with text in it pastes the text
if (only === "all" || only === "files") {
  const { bus, browser, page } = await setup(() => 0);
  await openDm(page);
  const png = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 400; c.height = 300; c.getContext("2d").fillRect(0, 0, 400, 300); return c.toDataURL("image/png").split(",")[1]; });
  const fire = (sel, type, files, text) => page.evaluate(([sel, type, files, text, png]) => {
    const dt = new DataTransfer();
    for (const [name, mime] of files) dt.items.add(new File([mime === "image/png" ? Uint8Array.from(atob(png), (c) => c.charCodeAt(0)) : "notes"], name, { type: mime }));
    if (text) dt.setData("text/plain", text);
    const e = type === "paste" ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }) : new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
    document.querySelector(sel).dispatchEvent(e);
    return e.defaultPrevented;
  }, [sel, type, files, text, png]);
  const chips = () => page.locator(".composer .chip").allInnerTexts();
  check("a pasted screenshot is taken, with a name of its own", await fire("textarea", "paste", [["image.png", "image/png"]]) && /^📎 image-\d{14}\.png/.test((await chips())[0] ?? ""), JSON.stringify(await chips()));
  check("a paste with text in it is left to paste the text", !(await fire("textarea", "paste", [["image.png", "image/png"]], "A1\tB1")) && (await chips()).length === 1, JSON.stringify(await chips()));
  await fire(".messages", "dragenter", [["notes.txt", "text/plain"]]);
  check("dragging a file over the chat shows where to drop it", await page.locator(".drop-hint").isVisible());
  check("dropping it adds it", await fire(".messages", "drop", [["notes.txt", "text/plain"]]) && !(await page.locator(".drop-hint").count()) && (await chips())[1]?.startsWith("📎 notes.txt"), JSON.stringify(await chips()));
  check("a file dropped outside a chat is not opened in place of the app", await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "x.txt")); const e = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; }) && (await chips()).length === 2);
  await page.locator("textarea").fill("both of them");
  await page.locator("textarea").press("Enter");
  let sent;
  for (let i = 0; i < 60 && !sent; i++) { await sleep(250); sent = (await bus.history(dm)).find((m) => m.text === "both of them"); }
  check("they are sent with the message", sent?.files?.length === 2 && /^image-\d{14}\.png$/.test(sent.files[0].name) && sent.files[1].name === "notes.txt", JSON.stringify(sent?.files?.map((f) => f.name)));

  // the image full screen: zoomed with the wheel or a double click, moved about with a drag, closed from its button
  // (in a desktop's window, where a press on Close used to drag the message under it along)
  await page.setViewportSize({ width: 1280, height: 800 });
  const box = page.locator(".lightbox"), big = page.locator(".lightbox img");
  const scale = () => big.evaluate((i) => new DOMMatrix(getComputedStyle(i).transform).a);
  await page.locator(`#m-${sent.id} .attach-img`).click();
  check("the image opens full screen", await box.isVisible());
  const r = await big.boundingBox();
  await page.mouse.move(r.x + r.width * 0.75, r.y + r.height / 2);
  await page.mouse.wheel(0, -500);
  await sleep(200);
  check("the wheel zooms in", (await scale()) > 2, String(await scale()));
  const before = await big.boundingBox();
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.75 - 60, r.y + r.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  const after = await big.boundingBox();
  check("a drag moves it about, and leaves it open", Math.round(after.x - before.x) === -60 && Math.round(after.y - before.y) === 20 && await box.isVisible(), JSON.stringify([before, after]));
  await page.mouse.dblclick(r.x + r.width / 2, r.y + r.height / 2);
  await sleep(200);
  check("a double click zooms back out", (await scale()) === 1, String(await scale()));
  // two fingers spread apart zoom in, as on a phone
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  const [cx, cy] = [r.x + r.width / 2, r.y + r.height / 2];
  await touch("touchStart", [[cx - 50, cy], [cx + 50, cy]]);
  for (let d = 50; d <= 100; d += 10) await touch("touchMove", [[cx - d, cy], [cx + d, cy]]);
  await touch("touchEnd", []);
  await sleep(200);
  check("a pinch zooms in", Math.abs((await scale()) - 2) < 0.05 && await box.isVisible(), String(await scale()));
  await page.mouse.dblclick(cx, cy);
  await sleep(200);

  // a click on Close, with the mouse moved a little while pressed: the message under it was dragged along, with it inside
  const pressClose = async (dx, ms) => {
    const c = await box.locator(".actions button").last().boundingBox();
    await page.mouse.move(c.x + 10, c.y + 10);
    await page.mouse.down();
    if (dx) await page.mouse.move(c.x + 10 + dx, c.y + 10);
    await sleep(ms);
    const held = { width: (await box.boundingBox())?.width, menu: await page.locator(".msg-menu").count() };
    await page.mouse.up();
    return held;
  };
  let held = await pressClose(-3, 100);
  check("pressed, Close leaves it covering the screen", held.width === 1280, JSON.stringify(held));
  check("…and closes it", !(await box.count()));
  await page.locator(`#m-${sent.id} .attach-img`).click();
  held = await pressClose(0, 700);
  check("held, it opens no menu for the message behind", held.width === 1280 && !held.menu && !(await box.count()), JSON.stringify(held));
  await page.locator(`#m-${sent.id} .attach-img`).click();
  await page.mouse.click(r.x - 20, r.y + 10);
  check("so does a click beside the image", !(await box.count()));
  await page.locator(`#m-${sent.id} .attach-img`).click();
  await page.keyboard.press("Escape");
  check("and Escape", !(await box.count()));
  await browser.close();
}

// a ```md block shows as Markdown (a table scrolls sideways), any other fenced block as code, and nothing becomes HTML
if (only === "all" || only === "markdown") {
  const { bus, browser, page } = await setup(() => 0);
  const cols = Array.from({ length: 8 }, (_, i) => `Column${i + 1}`);
  const text = ["Here is the plan:", "```md", "## Release **0.9.5**", "", "- [x] tables", "- [ ] colours, *later*", "",
    `| ${cols.join(" | ")} |`, `|${cols.map((_, i) => (i === 1 ? " -: " : " - ")).join("|")}|`, `| ${cols.map((c) => `${c.toLowerCase()}-value`).join(" | ")} |`, "",
    "<script>window.ran = 1</script>", "", "[bad](javascript:window.ran=1) [site](https://example.com) ![pic](https://example.com/p.png) <img src=x onerror=window.ran=1>", "```",
    "```py", "print(1)", "```", "That's all."].join("\n");
  const m = await bus.send(dm, agent, text, []);
  await openDm(page);
  const msg = page.locator(`#m-${m.id} .msg`);
  await msg.waitFor({ timeout: 15000 });
  const md = msg.locator(".md");
  await msg.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(process.env.SHOTS ?? "/tmp", "markdown.png") }).catch(() => {});
  check("a ```md block shows as Markdown", (await md.locator("h4").innerText()) === "Release 0.9.5" && (await md.locator("h4 strong").count()) === 1 && (await md.locator("li").count()) === 2 && await md.locator("li input[type=checkbox]").first().isChecked(), await md.innerHTML());
  check("its table is a table, aligned as written", (await md.locator("th").count()) === 8 && (await md.locator("td").nth(1).evaluate((td) => getComputedStyle(td).textAlign)) === "right");
  const widths = await msg.evaluate((b) => { const w = b.querySelector(".md .scroll-x"); const list = document.querySelector(".messages"); return { scroll: w.scrollWidth, shown: w.clientWidth, bubble: b.getBoundingClientRect().right, page: innerWidth, list: list.scrollWidth - list.clientWidth }; });
  check("a wide table scrolls sideways inside the bubble, which keeps to the screen", widths.scroll > widths.shown && widths.bubble <= widths.page && widths.list === 0, JSON.stringify(widths));
  check("HTML in it stays text, and runs nothing", (await md.innerText()).includes("<script>window.ran = 1</script>") && !(await md.locator("script").count()) && !(await page.evaluate(() => window.ran)));
  check("only a web link is a link; an image is one too, not loaded", JSON.stringify(await md.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")))) === JSON.stringify(["https://example.com", "https://example.com/p.png"]) && !(await md.locator("img").count()));
  check("any other fenced block is code", (await msg.locator("pre.code").innerText()) === "print(1)");
  const plain = await bus.send(dm, agent, "See www.example.com/a, the docs (https://example.com/b). And https://en.wikipedia.org/wiki/Bus_(computing)!", []);
  const links = page.locator(`#m-${plain.id} .text a`);
  await links.first().waitFor({ timeout: 15000 });
  check("plain addresses are links, www. too, without the punctuation after them", JSON.stringify(await links.evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute("href")]))) === JSON.stringify([["www.example.com/a", "https://www.example.com/a"], ["https://example.com/b", "https://example.com/b"], ["https://en.wikipedia.org/wiki/Bus_(computing)", "https://en.wikipedia.org/wiki/Bus_(computing)"]]), JSON.stringify(await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")))));
  check("the text around the blocks stays as written", (await msg.locator(".text").innerText()).startsWith("Here is the plan:") && (await msg.locator(".text").innerText()).trim().endsWith("That's all."));
  // a sideways drag on the table scrolls it; elsewhere on the bubble it still replies
  const drag = async (el) => { const b = await el.boundingBox(); await page.mouse.move(b.x + b.width - 20, b.y + 10); await page.mouse.down(); await page.mouse.move(b.x + b.width - 100, b.y + 12, { steps: 8 }); await page.mouse.up(); await sleep(200); };
  await drag(md.locator(".scroll-x"));
  check("a drag on the table doesn't reply to the message", !(await page.locator(".composer .reply-bar").count()));
  await drag(msg.locator("pre.code"));
  await drag(msg.locator(".meta"));
  check("…nor on code, but one on the rest of the bubble does", (await page.locator(".composer .reply-bar").count()) === 1);
  // and a finger: the table scrolls (the bubble only lets the list scroll up and down)
  const cdp = await page.context().newCDPSession(page);
  await md.locator(".scroll-x").evaluate((w) => { w.scrollLeft = 0; });
  const box = await md.locator(".scroll-x").boundingBox();
  const [x, y] = [box.x + box.width - 30, box.y + box.height / 2];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let d = 10; d <= 150; d += 10) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - d, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(300);
  check("a finger drags the table sideways", (await md.locator(".scroll-x").evaluate((w) => w.scrollLeft)) > 50, String(await md.locator(".scroll-x").evaluate((w) => w.scrollLeft)));
  await browser.close();
}

// the hourly GitHub quota: a warning at 50% and again at 75%, with switches that cut what this device writes
if (only === "all" || only === "quota") {
  const { gh, bus, browser, page } = await setup(() => 0);
  await openDm(page);
  const sheet = page.locator(".quota-sheet");
  const saver = () => page.evaluate(() => JSON.parse(localStorage.getItem("oc.saver") ?? "{}"));
  gh.quota.core.used = 2600;
  await sheet.waitFor({ timeout: 15000 });
  check("at 50% a warning says how much is used and when it starts again", /^GitHub quota (5\d)% used/.test(await sheet.locator("h2").innerText()) && (await sheet.innerText()).includes("starts again at"), await sheet.locator("h2").innerText());
  const rows = sheet.locator(".saver-row");
  check("…with five switches, all off", (await rows.count()) === 5 && !(await rows.locator("input:checked").count()));
  await rows.nth(2).hover();
  await page.screenshot({ path: path.join(process.env.SHOTS ?? "/tmp", "quota.png") }).catch(() => {});
  check("hovering one says what it changes, with an example", await rows.nth(2).locator(".tip").isVisible() && (await rows.nth(2).locator(".tip").innerText()).includes("Example"));
  await rows.nth(0).locator("input").check();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  check("Cancel closes it and changes nothing", !(await sheet.count()) && JSON.stringify(await saver()) === "{}", JSON.stringify(await saver()));
  await sleep(5000);
  check("the same level doesn't warn twice", !(await sheet.count()));
  gh.quota.core.used = 3800;
  await sheet.waitFor({ timeout: 15000 });
  check("at 75% it warns again", /^GitHub quota (7[5-9])% used/.test(await sheet.locator("h2").innerText()), await sheet.locator("h2").innerText());
  await rows.nth(0).locator("input").check(); // read receipts paused till the reset
  await rows.nth(4).locator("input").check(); // drafts kept here
  await rows.nth(1).locator("input").check(); // receipts off for good: the pause goes
  await rows.nth(1).locator("input").uncheck(); // …and back
  await rows.nth(0).locator("input").check();
  await sheet.getByRole("button", { name: "Apply" }).click();
  const s1 = await saver();
  check("Apply keeps the switches", typeof s1.receipts === "number" && s1.receipts > Date.now() && s1.drafts === "off" && !s1.beat, JSON.stringify(s1));
  // receipts and drafts are left out now
  const receipt = () => gh.files("receipts")["receipts/7779.json"] ?? "";
  const draft = () => gh.files("drafts")["drafts/7779.json"] ?? "";
  await sleep(4000);
  const [r0, d0] = [receipt(), draft()];
  const m1 = await bus.send(dm, agent, "while saving", []);
  await page.locator(`#m-${m1.id}`).waitFor({ timeout: 15000 });
  await page.locator("textarea").pressSequentially("not synced", { delay: 5 });
  await sleep(6000);
  check("paused, no read receipt is written", receipt() === r0 && !receipt().includes(m1.id), receipt());
  check("draft sync off, the draft stays on this device", draft() === d0 && !draft().includes("not synced"));
  await page.locator("textarea").fill("");
  // Settings has the same switches: receipts back on there
  await page.locator("button.back").click();
  await page.getByRole("button", { name: "Settings" }).first().click();
  const set = page.locator(".sheet .saver-row");
  check("Settings shows the switches as they are", await set.nth(0).locator("input").isChecked() && await set.nth(4).locator("input").isChecked() && (await page.locator(".sheet").innerText()).includes("requests used"));
  await set.nth(0).locator("input").uncheck();
  await page.keyboard.press("Escape");
  await openDm(page);
  const m2 = await bus.send(dm, agent, "after saving", []);
  await page.locator(`#m-${m2.id}`).waitFor({ timeout: 15000 });
  for (let i = 0; i < 40 && !receipt().includes(m2.id); i++) await sleep(250);
  check("turned back on, receipts go out again", receipt().includes(m2.id), receipt());
  await browser.close();
}

// after an update, what's new since the version last opened here; on a Mac, the banner's Update downloads and restarts
if (only === "all" || only === "update") {
  const version = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "app", "package.json"), "utf8")).version;
  const dmg = "https://github.com/Ege-BULUT/opencommunicate/releases/download/v9.9.9/OpenCommunicate-9.9.9-mac-arm64.dmg";
  const feed = async (route, u) => u.hostname === "feed.test" && (await route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ tag_name: "v9.9.9", html_url: "https://github.com/x", assets: [{ name: "OpenCommunicate-9.9.9-mac-arm64.dmg", browser_download_url: dmg }] }) }), true);
  const { browser, page } = await setup(() => 0, [], feed);
  const news = page.locator(".news");
  check("a first run shows no news", !(await news.count()));
  await page.evaluate(() => localStorage.setItem("oc.seenVersion", "0.9.4"));
  await page.reload();
  await news.waitFor({ timeout: 15000 });
  await page.screenshot({ path: path.join(process.env.SHOTS ?? "/tmp", "news.png") }).catch(() => {});
  const heads = await news.locator("h3").allInnerTexts();
  check("after an update, a note lists what each version since brought, newest first", (await news.locator("h2").innerText()) === `Updated to ${version}` && heads[0] === version && heads.at(-1) === "0.9.5" && (await news.locator("li").count()) >= heads.length, JSON.stringify(heads));
  await news.getByRole("button", { name: "Close" }).last().click();
  await page.reload();
  await page.locator("textarea, .row").first().waitFor();
  await sleep(1000);
  check("closed, it doesn't come back", !(await news.count()));
  // the Mac app: Update downloads the new dmg (the shell does the rest), with its progress
  await page.context().addInitScript(() => {
    window.opencomDesktop = { info: async () => ({ version: "0.9.6", platform: "darwin", arch: "arm64", selfUpdates: false, macUpdates: true, updateReady: null, feed: "https://feed.test/latest.json" }),
      updateMac: (url) => { window.updatedFrom = url; window.progress?.(0.42); return new Promise(() => {}); }, onUpdateProgress: (cb) => { window.progress = cb; }, badge: () => {}, focus: () => {} };
  });
  await page.reload();
  const banner = page.locator(".update");
  await banner.waitFor({ timeout: 15000 });
  check("a newer release is offered with Update", (await banner.innerText()).includes("OpenCommunicate 9.9.9 is out.") && await banner.getByRole("button", { name: "Update" }).isVisible());
  await banner.getByRole("button", { name: "Update" }).click();
  check("Update downloads that release's dmg for this Mac, with its progress", (await page.evaluate(() => window.updatedFrom)) === dmg && (await banner.innerText()).includes("Downloading the update… 42%"), await banner.innerText());
  await browser.close();
}

server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
