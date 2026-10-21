// Voice messages' text on an emulator or phone: feeds a 16 kHz mono 16-bit WAV to the app's Transcriber plugin
// (Android's on-device recognizer reading the recording, not the microphone) and prints what it heard. The app
// must be open with no chat stored, and allowed the microphone (adb shell pm grant com.egebulut.opencommunicate
// android.permission.RECORD_AUDIO). Make a recording on a Mac with:
//   say -v Samantha "I deployed the build to Vercel" -o en.wav --data-format=LEI16@16000
//   node test/android/transcribe.mjs en.wav en-US
import fs from "node:fs";
import { execFileSync } from "node:child_process";
const adb = (...a) => execFileSync(`${process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`}/platform-tools/adb`, a, { encoding: "utf8" }).trim();
const wav = fs.readFileSync(process.argv[2]);
let o = 12; while (wav.toString("ascii", o, o + 4) !== "data") o += 8 + wav.readUInt32LE(o + 4);
const pcm = wav.subarray(o + 8, o + 8 + wav.readUInt32LE(o + 4)).toString("base64");
const pid = adb("shell", "pidof", "com.egebulut.opencommunicate");
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const ws = new WebSocket(pages.find((p) => p.type === "page" && p.url.startsWith("https://localhost")).webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const t0 = Date.now();
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `Capacitor.Plugins.Transcriber.transcribe({ pcm: ${JSON.stringify(pcm)}, rate: 16000, language: ${JSON.stringify(process.argv[3] ?? "en-US")} }).then((r) => r.text, (e) => "ERROR " + e)`, awaitPromise: true, returnByValue: true } }));
const r = await new Promise((res) => ws.addEventListener("message", (e) => res(JSON.parse(e.data))));
console.log(`${Date.now() - t0} ms:`, JSON.stringify(r.result?.result?.value ?? r));
ws.close(); adb("forward", "--remove", "tcp:9333");
