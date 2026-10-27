import type { Quota } from "../../core/src/index.ts";
import { LOCALE, S } from "./i18n.tsx";

/** What this device leaves out to spare GitHub's hourly quota, which every device and agent of an account shares:
 *  "off" until turned back on, a time (epoch ms) for "until the quota starts again". */
export type Saver = { receipts?: "off" | number; beat?: "off" | number; drafts?: "off" };
const KEY = "oc.saver";
export const readSaver = (): Saver => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } };
export const writeSaver = (s: Saver) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: this session only */ } };
const pausedTill = (v: Saver[keyof Saver]) => typeof v === "number" && Date.now() < v;
export const saving = (s: Saver, k: keyof Saver) => s[k] === "off" || pausedTill(s[k]);

/** The quota closest to running out. */
export const fullest = (q: Record<string, Quota>): Quota | null =>
  Object.values(q).filter((x) => x.limit).sort((a, b) => b.used / b.limit - a.used / a.limit)[0] ?? null;
export const percent = (q: Quota) => Math.floor((q.used / q.limit) * 100);
export const clock = (ms: number) => new Date(ms).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });

/** Each quota warns at 50% and again at 75%, once an hour (a warning seen on this device is not shown again). */
const WARNED = "oc.quotaWarned";
export function warnLevel(q: Quota): number {
  const pct = q.used / q.limit, level = pct >= 0.75 ? 75 : pct >= 0.5 ? 50 : 0;
  if (!level) return 0;
  const key = `${q.resource}:${q.reset}`;
  let was: { key?: string; level?: number } = {};
  try { was = JSON.parse(localStorage.getItem(WARNED) ?? "{}"); } catch { /* none */ }
  if (was.key === key && (was.level ?? 0) >= level) return 0;
  try { localStorage.setItem(WARNED, JSON.stringify({ key, level })); } catch { /* private mode: may warn again */ }
  return level;
}

/** The switches: each one on or off, with what it changes on hover (or a tap on ⓘ). `resetAt` is when the quota
 *  starts again (epoch ms), the end of a pause. */
export function SaverOptions({ value, resetAt, onChange }: { value: Saver; resetAt: number; onChange: (s: Saver) => void }) {
  const at = clock(resetAt);
  const set = (k: keyof Saver, v: Saver[keyof Saver]) => { const n = { ...value }; if (v === undefined) delete n[k]; else (n as Record<string, unknown>)[k] = v; onChange(n); };
  const rows: { id: string; on: boolean; change: (on: boolean) => void; label: string; tip: string }[] = [
    { id: "receipts-pause", on: pausedTill(value.receipts), change: (on) => set("receipts", on ? resetAt : undefined), label: S.saverReceiptsPause(at), tip: S.saverReceiptsPauseTip(at) },
    { id: "receipts-off", on: value.receipts === "off", change: (on) => set("receipts", on ? "off" : undefined), label: S.saverReceiptsOff, tip: S.saverReceiptsOffTip },
    { id: "beat-pause", on: pausedTill(value.beat), change: (on) => set("beat", on ? resetAt : undefined), label: S.saverBeatPause(at), tip: S.saverBeatPauseTip(at) },
    { id: "beat-off", on: value.beat === "off", change: (on) => set("beat", on ? "off" : undefined), label: S.saverBeatOff, tip: S.saverBeatOffTip },
    { id: "drafts-off", on: value.drafts === "off", change: (on) => set("drafts", on ? "off" : undefined), label: S.saverDraftsOff, tip: S.saverDraftsOffTip },
  ];
  return (
    <div className="saver">
      {rows.map((r) => (
        <label key={r.id} className="saver-row">
          <input type="checkbox" role="switch" checked={r.on} onChange={(e) => r.change(e.target.checked)} aria-describedby={`tip-${r.id}`} />
          <span>{r.label}</span>
          <span className="tip-wrap">
            <button type="button" className="tip-btn" aria-label={S.saverWhat}>ⓘ</button>
            <span id={`tip-${r.id}`} role="tooltip" className="tip">{r.tip}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
