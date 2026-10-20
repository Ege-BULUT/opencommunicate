/* Reading a message aloud, each run of it (core/src/voice.ts) in a voice of its own language: Android's
   text-to-speech on the phone, the system's voices (speechSynthesis) on the desktop and the web. Both use the
   voices installed on the device, so it is free, works offline and has no limit. */
import { SpeechRecognition } from "@capgo/capacitor-speech-recognition";
import { QueueStrategy, TextToSpeech } from "@capacitor-community/text-to-speech";
import { speechRuns, type Lang } from "../../core/src/voice.ts";
import { lang as appLang } from "./i18n.tsx";
import { native } from "./session.ts";
// ONNX Runtime's WebAssembly, shipped with the app rather than fetched from a CDN, so dictation works offline once
// the model is in (the phone build drops these files: Android dictates with its own recognizer)
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";

const TAG: Record<Lang, string> = { tr: "tr-TR", en: "en-US" };

/** The device has no voice for this language: Android can download one (`installVoice`), a computer adds it in
 *  its speech settings. */
export class NoVoice extends Error { constructor(readonly lang: Lang) { super(`no ${lang} voice`); } }
export const installVoice = () => TextToSpeech.openInstall().catch(() => {});

let stopped = () => {};

/** Reads `text` aloud; settles when it is done or stopped. Throws NoVoice for a language the device cannot speak. */
export async function readAloud(text: string): Promise<void> {
  stopped();
  await TextToSpeech.stop().catch(() => {});
  const stop = new Promise<void>((r) => (stopped = r));
  let done = false;
  stop.then(() => (done = true));
  const runs = speechRuns(text);
  if (!native() && typeof speechSynthesis !== "undefined" && !speechSynthesis.getVoices().length) {
    // the browser lists its voices a moment after the page loads
    await new Promise((r) => { speechSynthesis.addEventListener("voiceschanged", r, { once: true }); setTimeout(r, 1500); });
  }
  if (native()) {
    // All queued at once, so a language change makes no pause; each promise settles once its run is spoken, and
    // stop() leaves them unsettled, hence the race. Android is asked nothing first: right after start its engine
    // says no language is available. A run that fails is a voice the phone lacks (with no voice data downloaded,
    // Google's engine tries a network voice, and offline that fails).
    const spoken = runs.map((r) => TextToSpeech.speak({ text: r.text, lang: TAG[r.lang], queueStrategy: QueueStrategy.Add }).catch(() => { throw new NoVoice(r.lang); }));
    try { await Promise.race([Promise.all(spoken), stop]); }
    catch (e) { stopReading(); throw e; }
    return;
  }
  for (const lang of new Set(runs.map((r) => r.lang))) {
    if (!(await TextToSpeech.isLanguageSupported({ lang: TAG[lang] })).supported) throw new NoVoice(lang);
  }
  for (const r of runs) {
    if (done) return;
    try { await TextToSpeech.speak({ text: r.text, lang: TAG[r.lang] }); } // the browser picks a voice of that language
    catch (e) { if (done) return; throw e; } // stopping cancels the run being spoken
  }
}

export function stopReading(): void {
  stopped();
  TextToSpeech.stop().catch(() => {});
}

/* Dictation: speech to text on the device. On Android the phone's on-device recognizer (Android 13 and later,
   with the language's model downloaded, which Android does itself); on the desktop and the web, Whisper running
   in the page (transformers.js), downloaded once. Neither sends audio anywhere. */
/** This device cannot take dictation in that language without sending audio away. */
export class NoDictation extends Error { constructor() { super("no on-device speech recognition"); } }

export type Dictation = { stop: () => void };
const DICTATION = "oc.dictation"; // the language dictation listens for; the app's language until one is picked
export const dictationLang = (): Lang => { try { const v = localStorage.getItem(DICTATION); if (v === "tr" || v === "en") return v; } catch { /* the default */ } return appLang; };
export const setDictationLang = (l: Lang) => { try { localStorage.setItem(DICTATION, l); } catch { /* this session only */ } };
export type Listener = {
  text: (text: string) => void;              // the transcript so far, each time it changes
  end: (error?: string) => void;             // once, with a message when it failed
  stage?: (s: "transcribing" | number) => void; // the desktop's: writing it out, or the model download's progress (0–1)
};

/** Listens until stopped or, on the phone, until a pause. */
export async function dictate(lang: Lang, { text: onText, end: onEnd, stage }: Listener): Promise<Dictation> {
  if (!native()) return whisperDictation(lang, onText, onEnd, stage ?? (() => {}));
  const language = TAG[lang];
  if (!(await SpeechRecognition.isOnDeviceRecognitionAvailable({ language }).catch(() => ({ available: false }))).available) throw new NoDictation();
  if ((await SpeechRecognition.requestPermissions()).speechRecognition !== "granted") throw new Error("microphone permission denied");
  let ended = false, stopping = false, handles: { remove: () => Promise<void> }[] = [];
  const end = (error?: string) => {
    if (ended) return;
    ended = true;
    handles.forEach((h) => h.remove());
    onEnd(error);
  };
  handles = await Promise.all([
    SpeechRecognition.addListener("partialResults", (e) => { const t = e.accumulatedText ?? e.matches?.[0]; if (t) onText(t); }),
    // stopping reports a CLIENT error, and a pause with nothing said ends it: both quietly
    SpeechRecognition.addListener("error", (e) => end(stopping || e.code === "NO_MATCH" || e.code === "SPEECH_TIMEOUT" ? undefined : e.message)),
    SpeechRecognition.addListener("listeningState", (e) => { if (e.state === "stopped" || e.status === "stopped") end(); }),
  ]);
  await SpeechRecognition.start({ language, partialResults: true, useOnDeviceRecognition: true, popup: false }).catch((e) => end((e as Error).message));
  return { stop: () => { stopping = true; SpeechRecognition.stop().catch(() => {}); } };
}

/* Whisper large-v3-turbo, 4-bit: about 560 MB on a GPU (WebGPU), 760 MB on the processor, downloaded from
   Hugging Face on first use and kept in the browser's cache. It hears English terms inside Turkish well,
   better still when told which to expect. */
const WHISPER = "onnx-community/whisper-large-v3-turbo";
const VOCAB = " Vercel, Claude, GPT, OpenCommunicate, GitHub, deploy, commit, push, pull request, API, MCP.";
const READY = "oc.whisper"; // set once the model has loaded on this device
export const whisperReady = () => { try { return localStorage.getItem(READY) === "1"; } catch { return false; } };

type Whisper = { model: any; processor: any; tokenizer: any; Tensor: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
let whisper: Promise<Whisper> | null = null;
function loadWhisper(progress: (p: number) => void): Promise<Whisper> {
  return (whisper ??= (async () => {
    const { AutoProcessor, AutoTokenizer, WhisperForConditionalGeneration, Tensor, env } = await import("@huggingface/transformers");
    env.backends.onnx.wasm!.wasmPaths = { mjs: new URL(ortMjs, location.href).href, wasm: new URL(ortWasm, location.href).href };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = "gpu" in navigator ? await (navigator as any).gpu.requestAdapter().catch(() => null) : null;
    const files = new Map<string, [number, number]>();
    let shown = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const progress_callback = (p: any) => {
      if (p.status !== "progress") return;
      files.set(p.file, [p.loaded, p.total]);
      const [a, b] = [...files.values()].reduce(([x, y], [l, t]) => [x + l, y + t], [0, 0]);
      if (a / b > shown) progress((shown = a / b));
    };
    const [model, processor, tokenizer] = await Promise.all([
      WhisperForConditionalGeneration.from_pretrained(WHISPER, { device: gpu ? "webgpu" : "wasm", dtype: gpu?.features.has("shader-f16") ? "q4f16" : "q4", progress_callback }),
      AutoProcessor.from_pretrained(WHISPER),
      AutoTokenizer.from_pretrained(WHISPER),
    ]);
    try { localStorage.setItem(READY, "1"); } catch { /* asks again next time */ }
    return { model, processor, tokenizer, Tensor };
  })().catch((e) => { whisper = null; throw e; }));
}

const RATE = 16000;
const rms = (a: Float32Array) => { let s = 0; for (const x of a) s += x * x; return Math.sqrt(s / (a.length || 1)); };
/** Where to end a window that starts at `from`: 30 s on (Whisper's window), or the quietest tenth of a second in
 *  its last 5 s, so no word is cut in two. */
function windowEnd(audio: Float32Array, from: number): number {
  const end = from + 30 * RATE;
  if (end >= audio.length) return audio.length;
  let best = end, quiet = Infinity;
  for (let t = end - 5 * RATE; t + RATE / 10 <= end; t += RATE / 10) {
    const level = rms(audio.subarray(t, t + RATE / 10));
    if (level < quiet) { quiet = level; best = t + RATE / 20; }
  }
  return best;
}

/** 16 kHz mono audio to text, a window at a time, each told the vocabulary and what the last one said. */
async function transcribe(audio: Float32Array, lang: Lang, progress: (p: number) => void): Promise<string> {
  const { model, processor, tokenizer, Tensor } = await loadWhisper(progress);
  const id = (t: string) => tokenizer.convert_tokens_to_ids([t])[0];
  const said: string[] = [];
  for (let i = 0, j: number; i < audio.length; i = j) {
    j = windowEnd(audio, i);
    const part = audio.subarray(i, j);
    if (rms(part) < 0.0015) continue; // silence (about -56 dBFS): Whisper would invent words
    const { input_features } = await processor(part);
    const prev = tokenizer.encode(VOCAB + (said.length ? ` ${said.at(-1)!.slice(-120)}` : ""), { add_special_tokens: false });
    const start = [id("<|startofprev|>"), ...prev, id("<|startoftranscript|>"), id(`<|${lang}|>`), id("<|transcribe|>"), id("<|notimestamps|>")];
    const out = await model.generate({ inputs: input_features, decoder_input_ids: new Tensor("int64", BigInt64Array.from(start.map(BigInt)), [1, start.length]), max_new_tokens: 444 - start.length }); // the decoder holds 448 tokens, prompt included
    said.push(tokenizer.decode(Array.from(out.tolist()[0] as bigint[]).slice(start.length).map(Number), { skip_special_tokens: true }).trim());
  }
  return said.filter(Boolean).join(" ");
}

const MAX_RECORDING = 5 * 60_000; // one transcription after Stop: on a processor, minutes for a long recording

async function whisperDictation(lang: Lang, onText: (t: string) => void, onEnd: (error?: string) => void, stage: (s: "transcribing" | number) => void): Promise<Dictation> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let rec: MediaRecorder;
  try { rec = new MediaRecorder(stream); } catch (e) { release(); throw e; }
  loadWhisper(stage).catch(() => {}); // the model loads while you speak
  const parts: Blob[] = [];
  const cap = setTimeout(() => stop(), MAX_RECORDING);
  const stop = () => { clearTimeout(cap); if (rec.state !== "inactive") rec.stop(); };
  rec.ondataavailable = (e) => parts.push(e.data);
  rec.onerror = () => { clearTimeout(cap); release(); onEnd("the microphone stopped"); };
  rec.onstop = async () => {
    release();
    const blob = new Blob(parts);
    if (!blob.size) { onEnd(); return; } // stopped before anything was recorded
    const ctx = new AudioContext({ sampleRate: RATE }); // decoding resamples to it
    try {
      stage("transcribing");
      const text = await transcribe((await ctx.decodeAudioData(await blob.arrayBuffer())).getChannelData(0), lang, stage);
      if (text) onText(text);
      onEnd();
    } catch (e) { onEnd((e as Error).message); }
    finally { ctx.close(); }
  };
  rec.start();
  return { stop };
}
