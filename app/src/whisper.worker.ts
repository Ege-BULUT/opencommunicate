/* Whisper large-v3-turbo, 4-bit, in a worker for app/src/voice.ts: about 560 MB on a GPU (WebGPU), 760 MB on the
   processor, downloaded from Hugging Face on first use and kept in the browser's cache. It hears English terms
   inside Turkish well, better still when told which to expect.
   In: { id, type: "load" } or { id, type: "transcribe", audio (16 kHz mono), lang }.
   Out: { id, progress } while the model downloads, then { id, text } or { id, error }. */
import { AutoProcessor, AutoTokenizer, Tensor, WhisperForConditionalGeneration, env } from "@huggingface/transformers";
// ONNX Runtime's WebAssembly, shipped with the app rather than fetched from a CDN, so dictation works offline once
// the model is in (the phone build drops these files: Android dictates with its own recognizer)
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import type { Lang } from "../../core/src/voice.ts";

const WHISPER = "onnx-community/whisper-large-v3-turbo";
const VOCAB = " Vercel, Claude, GPT, OpenCommunicate, GitHub, deploy, commit, push, pull request, API, MCP.";

type Whisper = { model: any; processor: any; tokenizer: any; Tensor: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
let whisper: Promise<Whisper> | null = null;
let report = (_p: number) => {}; // the download's progress goes to whichever job is waiting now
function loadWhisper(): Promise<Whisper> {
  return (whisper ??= (async () => {
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
      if (a / b > shown) report((shown = a / b));
    };
    const model = (device: "webgpu" | "wasm", dtype: "q4f16" | "q4") => WhisperForConditionalGeneration.from_pretrained(WHISPER, { device, dtype, progress_callback });
    const [processor, tokenizer] = await Promise.all([AutoProcessor.from_pretrained(WHISPER), AutoTokenizer.from_pretrained(WHISPER)]);
    // a graphics card that offers WebGPU but fails to run the model falls back to the processor
    // (a download that broke is no reason to fetch the processor's files too)
    const onGpu = gpu ? await model("webgpu", gpu.features.has("shader-f16") ? "q4f16" : "q4").catch((e) => { if (/fetch|network/i.test(String(e?.message ?? e))) throw e; return null; }) : null;
    return { model: onGpu ?? (await model("wasm", "q4")), processor, tokenizer, Tensor };
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
  report = progress;
  const { model, processor, tokenizer, Tensor } = await loadWhisper();
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


self.onmessage = async (e: MessageEvent<{ id: number; type: "load" | "transcribe"; audio?: Float32Array; lang?: Lang }>) => {
  const { id, type, audio, lang } = e.data;
  const progress = (p: number) => self.postMessage({ id, progress: p });
  try {
    if (type === "load") { report = progress; await loadWhisper(); self.postMessage({ id, text: "" }); }
    else self.postMessage({ id, text: await transcribe(audio!, lang!, progress) });
  } catch (err) { self.postMessage({ id, error: (err as Error).message ?? String(err) }); }
};
