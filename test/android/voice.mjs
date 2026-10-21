// The voice plugins on an emulator or a phone, called from the app's WebView through Chrome DevTools the way
// app/src/voice.ts does. Start the app with no chat stored (the sign-in screen reaches nothing), then:
//   node test/android/voice.mjs
import { execFileSync } from "node:child_process";
const adb = (...a) => execFileSync(`${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`, a, { encoding: "utf8" }).trim();
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`); };

const pid = adb("shell", "pidof", "com.egebulut.opencommunicate");
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let next = 1;
const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); });
const run = (expression) => new Promise((r) => { const id = next++; waiting.set(id, r); ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); })
  .then((m) => m.result?.exceptionDetails ? { error: m.result.exceptionDetails.exception?.description ?? m.result.exceptionDetails.text } : m.result?.result?.value);

const P = "Capacitor.Plugins";
const langs = await run(`${P}.TextToSpeech.getSupportedLanguages().then((r) => r.languages)`);
check("text-to-speech answers, with its languages", Array.isArray(langs) && langs.length > 0, JSON.stringify(langs)?.slice(0, 200));
const en = await run(`${P}.TextToSpeech.isLanguageSupported({ lang: "en-US" })`);
const tr = await run(`${P}.TextToSpeech.isLanguageSupported({ lang: "tr-TR" })`);
console.log("  en-US:", JSON.stringify(en), "tr-TR:", JSON.stringify(tr));
// runs queued at once (QueueStrategy.Add = 1): each promise settles when its run has been spoken, in order
const order = await run(`(async () => {
  const done = [];
  const t0 = Date.now();
  const say = (text, lang, i) => ${P}.TextToSpeech.speak({ text, lang, queueStrategy: 1 }).then(() => done.push([i, Date.now() - t0]));
  await Promise.all([say("vercel", "en-US", 0), say("deploy etti, sonra", "${tr?.supported ? "tr-TR" : "en-US"}", 1), say("GPT", "en-US", 2)]);
  return done;
})()`);
check("queued runs are spoken in order, each settling when done", Array.isArray(order) && order.map((x) => x[0]).join() === "0,1,2" && order[2][1] > 500, JSON.stringify(order));
// stop() in the middle: the queue is dropped
const stopped = await run(`(async () => {
  const p = ${P}.TextToSpeech.speak({ text: "one two three four five six seven eight nine ten eleven twelve", lang: "en-US", queueStrategy: 1 }).then(() => "settled");
  await new Promise((r) => setTimeout(r, 700));
  await ${P}.TextToSpeech.stop();
  return Promise.race([p, new Promise((r) => setTimeout(() => r("left unsettled"), 3000))]);
})()`);
check("stop() works (a stopped run may stay unsettled, which voice.ts races)", stopped === "settled" || stopped === "left unsettled", stopped);
const sr = await run(`${P}.SpeechRecognition.available()`);
check("speech recognition plugin answers", sr && typeof sr.available === "boolean", JSON.stringify(sr));
const onDevice = await run(`Promise.all(["tr-TR", "en-US"].map((language) => ${P}.SpeechRecognition.isOnDeviceRecognitionAvailable({ language })))`);
console.log("  on-device recognition tr-TR, en-US:", JSON.stringify(onDevice));
check("on-device check answers for both languages", Array.isArray(onDevice) && onDevice.every((x) => typeof x?.available === "boolean"), JSON.stringify(onDevice));
ws.close();
adb("forward", "--remove", "tcp:9333");
console.log(`${results.filter(Boolean).length}/${results.length}`);
