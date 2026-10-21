/* Reading a message aloud, each run of it (core/src/voice.ts) in a voice of its own language: Android's
   text-to-speech on the phone, the system's voices (speechSynthesis) on the desktop and the web. Both use the
   voices installed on the device, so it is free, works offline and has no limit. */
import { registerPlugin } from "@capacitor/core";
import { SpeechRecognition } from "@capgo/capacitor-speech-recognition";
import { QueueStrategy, TextToSpeech } from "@capacitor-community/text-to-speech";
import { toBase64 } from "../../core/src/index.ts";
import { speechRuns, type Lang } from "../../core/src/voice.ts";
import { lang as appLang } from "./i18n.tsx";
import { native } from "./session.ts";

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

/* Whisper runs in a worker (whisper.worker.ts): loading the model and transcribing would freeze the page for
   seconds. Each request carries an id; the worker answers with progress, then the result or an error. */
const READY = "oc.whisper"; // set once the model has loaded on this device
export const whisperReady = () => { try { return localStorage.getItem(READY) === "1"; } catch { return false; } };
const RATE = 16000;

type Job = { progress: (p: number) => void; resolve: (v: string) => void; reject: (e: Error) => void };
const jobs = new Map<number, Job>();
let worker: Worker | null = null, nextJob = 1;
async function whisper(request: { type: "load" } | { type: "transcribe"; audio: Float32Array; lang: Lang }, progress: (p: number) => void): Promise<string> {
  worker ??= Object.assign(new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" }), {
    // a worker that fails to start or crashes: every waiting job fails, and the next one starts a new worker
    onerror: (e: ErrorEvent) => { e.preventDefault(); for (const job of jobs.values()) job.reject(new Error(e.message || "speech recognition stopped")); jobs.clear(); worker?.terminate(); worker = null; },
    onmessage: (e: MessageEvent<{ id: number; progress?: number; text?: string; error?: string }>) => {
      const job = jobs.get(e.data.id);
      if (!job) return;
      if (e.data.progress !== undefined) return job.progress(e.data.progress);
      jobs.delete(e.data.id);
      if (e.data.error !== undefined) job.reject(new Error(e.data.error));
      else { try { localStorage.setItem(READY, "1"); } catch { /* asks again next time */ } job.resolve(e.data.text ?? ""); }
    },
  });
  const id = nextJob++;
  return new Promise((resolve, reject) => {
    jobs.set(id, { progress, resolve, reject });
    worker!.postMessage({ id, ...request }, request.type === "transcribe" ? [request.audio.buffer] : []);
  });
}

const MAX_RECORDING = 5 * 60_000; // one transcription after Stop: on a processor, minutes for a long recording

/** A recording from the microphone, until stop() (or 5 minutes): Opus in WebM where the browser has it. */
export type Recording = { stop: () => Promise<{ blob: Blob; ms: number }>; cancel: () => void };
export async function record(onError: (e: string) => void = () => {}): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const opus = "audio/webm;codecs=opus";
  let rec: MediaRecorder;
  try { rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported(opus) ? { mimeType: opus, audioBitsPerSecond: 32000 } : undefined); }
  catch (e) { release(); throw e; }
  const parts: Blob[] = [], t0 = Date.now();
  const done = new Promise<{ blob: Blob; ms: number }>((resolve) => {
    rec.onstop = () => { release(); resolve({ blob: new Blob(parts, { type: (rec.mimeType || "audio/webm").split(";")[0] }), ms: Date.now() - t0 }); };
  });
  const stop = () => { clearTimeout(cap); if (rec.state !== "inactive") rec.stop(); return done; };
  const cap = setTimeout(stop, MAX_RECORDING);
  rec.ondataavailable = (e) => parts.push(e.data);
  rec.onerror = () => { clearTimeout(cap); release(); onError("the microphone stopped"); };
  rec.start();
  return { stop, cancel: () => { parts.length = 0; stop(); } };
}

/** Android's on-device recognizer fed a recording instead of the microphone (app/android: TranscriberPlugin). */
const Transcriber = registerPlugin<{ transcribe(o: { pcm: string; rate: number; language: string }): Promise<{ text: string }> }>("Transcriber");

/** What a recording says: Whisper on the desktop and the web, Android's on-device recognizer on the phone. */
export async function transcribe(blob: Blob, lang: Lang, stage: (s: "transcribing" | number) => void = () => {}): Promise<string> {
  if (!blob.size) return "";
  const ctx = new AudioContext({ sampleRate: RATE }); // decoding resamples to it
  let audio: Float32Array;
  try { audio = new Float32Array((await ctx.decodeAudioData(await blob.arrayBuffer())).getChannelData(0)); } // a copy the worker can own
  finally { ctx.close(); }
  stage("transcribing");
  if (!native()) return whisper({ type: "transcribe", audio, lang }, stage);
  const pcm = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i] * 32767)));
  return (await Transcriber.transcribe({ pcm: toBase64(new Uint8Array(pcm.buffer)), rate: RATE, language: TAG[lang] })).text;
}
/** On the desktop, the speech model loading while you speak. */
export const warmUp = (stage: (s: "transcribing" | number) => void) => { if (!native()) whisper({ type: "load" }, stage).catch(() => {}); };

async function whisperDictation(lang: Lang, onText: (t: string) => void, onEnd: (error?: string) => void, stage: (s: "transcribing" | number) => void): Promise<Dictation> {
  const rec = await record((e) => onEnd(e));
  warmUp(stage);
  return {
    stop: () => {
      rec.stop()
        .then(({ blob }) => transcribe(blob, lang, stage))
        .then((text) => { if (text) onText(text); onEnd(); }, (e) => onEnd((e as Error).message));
    },
  };
}
