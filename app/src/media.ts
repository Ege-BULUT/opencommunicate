/* Pictures and attachments on this device.
   A file is fetched from GitHub once per session and kept in memory. When the person chose "Cihaza kaydet" for
   that kind of media (Settings → Medya), it is also kept in IndexedDB, so it opens again without the network;
   "GitHub'dan aktar" keeps nothing on the device. Sending adds a ~1 KB preview and the size to images and videos;
   profile photos are shrunk until they fit in 50 KB. */
import { PHOTO_MAX, type Bus, type FileRef, type Upload } from "../../core/src/index.ts";

export type MediaKind = "image" | "video";
export type MediaMode = "save" | "stream";
const MODES = "oc.media";

export function mediaModes(): Record<MediaKind, MediaMode> {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(MODES) ?? "{}"); } catch { /* defaults */ }
  return { image: "save", video: "stream", ...saved };
}
export const setMediaMode = (kind: MediaKind, mode: MediaMode) => localStorage.setItem(MODES, JSON.stringify({ ...mediaModes(), [kind]: mode }));

const EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4" };
export const mimeOf = (f: Pick<FileRef, "name" | "type">) => f.type || EXT[f.name.split(".").pop()?.toLowerCase() ?? ""] || "";
export function kindOf(f: Pick<FileRef, "name" | "type">): MediaKind | null {
  const m = mimeOf(f);
  return m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : null;
}

// ---------- device store (IndexedDB: works in the phone's WebView, Electron and browsers) ----------
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("opencommunicate", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = run(db.transaction("files", mode).objectStore("files"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const stored = (path: string) => tx<Uint8Array | undefined>("readonly", (s) => s.get(path)).catch(() => undefined);
const store = (path: string, data: Uint8Array) => tx("readwrite", (s) => s.put(data, path)).catch(() => undefined);
export const clearStored = () => tx("readwrite", (s) => s.clear());
export async function storedSize(): Promise<number> {
  const all = await tx<Uint8Array[]>("readonly", (s) => s.getAll()).catch(() => []);
  return all.reduce((n, d) => n + d.byteLength, 0);
}

const memory = new Map<string, Promise<Uint8Array>>();

/** A file's bytes: from memory, else from the device, else from GitHub (then kept on the device if `keep`). */
export function fetchFile(bus: Bus, path: string, keep: boolean): Promise<Uint8Array> {
  let p = memory.get(path);
  if (!p) {
    p = (async () => {
      const local = await stored(path);
      if (local) return local;
      const data = await bus.file(path);
      if (keep) await store(path, data);
      return data;
    })();
    memory.set(path, p);
    p.catch(() => memory.delete(path));
  }
  return p;
}
/** Is the file already here (this session, or kept on the device)? Then it shows without a tap. */
export const isLocal = async (path: string) => memory.has(path) || !!(await stored(path));
/** Something this device just sent: no need to download it again. */
export function remember(path: string, data: Uint8Array, keep: boolean) {
  memory.set(path, Promise.resolve(data));
  if (keep) store(path, data);
}

const urls = new Map<string, string>();
export function objectUrl(path: string, data: Uint8Array, type: string): string {
  if (!urls.has(path)) urls.set(path, URL.createObjectURL(new Blob([data as BlobPart], { type })));
  return urls.get(path)!;
}

// ---------- previews and shrinking (canvas) ----------
function canvasFor(src: CanvasImageSource, w: number, h: number, max: number) {
  const k = Math.min(1, max / Math.max(w, h));
  const c = Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) });
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const blobOf = (c: HTMLCanvasElement, type: string, q: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, q));
/** WebP where the device can encode it (a canvas that can't hands back PNG instead), else JPEG. */
async function encode(c: HTMLCanvasElement, q: number): Promise<Blob> {
  const webp = await blobOf(c, "image/webp", q);
  return webp?.type === "image/webp" ? webp : (await blobOf(c, "image/jpeg", q))!;
}
const dataUrl = (b: Blob) => new Promise<string>((r) => { const f = new FileReader(); f.onload = () => r(String(f.result)); f.readAsDataURL(b); });

/** A frame of a video (a moment in, past a black first frame), or null if this device can't decode it. */
function videoFrame(file: File): Promise<{ v: HTMLVideoElement; done: () => void } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto", src: url });
    const done = () => URL.revokeObjectURL(url);
    const fail = () => { done(); resolve(null); };
    const timer = setTimeout(fail, 5000);
    v.onerror = () => { clearTimeout(timer); fail(); };
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); };
    v.onseeked = () => { clearTimeout(timer); resolve({ v, done }); };
  });
}

/** Size and a ~1 KB preview for an image or video about to be sent; nothing for other files. */
export async function describe(file: File): Promise<Pick<Upload, "type" | "w" | "h" | "thumb">> {
  const type = file.type || mimeOf({ name: file.name });
  try {
    if (type.startsWith("image/")) {
      const bmp = await createImageBitmap(file);
      const thumb = await dataUrl(await encode(canvasFor(bmp, bmp.width, bmp.height, 24), 0.5));
      return { type, w: bmp.width, h: bmp.height, thumb };
    }
    if (type.startsWith("video/")) {
      const f = await videoFrame(file);
      if (!f) return { type };
      const thumb = await dataUrl(await encode(canvasFor(f.v, f.v.videoWidth, f.v.videoHeight, 24), 0.5));
      const out = { type, w: f.v.videoWidth, h: f.v.videoHeight, thumb };
      f.done();
      return out;
    }
  } catch { /* sent without a preview */ }
  return type ? { type } : {};
}

/** A photo shrunk (and re-encoded) until it fits in `max` bytes, for a profile picture. */
export async function shrinkPhoto(file: File, max = PHOTO_MAX): Promise<{ data: Uint8Array; ext: string; url: string }> {
  const bmp = await createImageBitmap(file);
  for (const side of [512, 384, 256, 192, 128, 96]) {
    const c = canvasFor(bmp, bmp.width, bmp.height, side);
    for (const q of [0.85, 0.7, 0.55, 0.4]) {
      const b = await encode(c, q);
      if (b.size <= max) {
        const ext = b.type === "image/webp" ? "webp" : b.type === "image/png" ? "png" : "jpg";
        return { data: new Uint8Array(await b.arrayBuffer()), ext, url: URL.createObjectURL(b) };
      }
    }
  }
  throw new Error("Bu fotoğraf 50 KB'a sığacak kadar küçültülemedi.");
}
