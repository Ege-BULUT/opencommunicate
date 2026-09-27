/* Phone notifications through ntfy (https://ntfy.sh, free, no account). A device that turns them on stores
   its own secret topic URL in devices/<id>.json (the bus repo is private); whoever sends a message posts a
   short notice to the recipients' topics. The ntfy app on the phone shows it at once. */
import { dmPeer, handle, isDm, wantsNotice, type Device, type Group, type Message } from "./index.ts";

export function recipients(m: Message, devices: Device[], groups: Group[]): Device[] {
  const others = devices.filter((d) => d.id !== m.from);
  if (m.channel === "all") return others;
  if (isDm(m.channel)) return others.filter((d) => d.id === dmPeer(m.channel, m.from));
  const g = groups.find((x) => x.channel === m.channel);
  return g ? others.filter((d) => g.members.includes(d.id)) : [];
}

export async function notifyRecipients(m: Message, from: Device, devices: Device[], groups: Group[], f: typeof fetch = fetch): Promise<number> {
  const where = m.channel === "all" ? "#all" : isDm(m.channel) ? "" : `#${groups.find((g) => g.channel === m.channel)?.name ?? m.channel}`;
  const title = `${handle(from)}${where ? ` → ${where}` : ""}`;
  const body = (m.text || (m.files?.length ? `📎 ${m.files.map((x) => x.name).join(", ")}` : "")).slice(0, 200);
  // a recipient who muted the channel, or wants only mentions there, is skipped
  const targets = recipients(m, devices, groups).filter((d) => /^https:\/\/ntfy\.sh\/[\w-]{12,64}$/.test(d.notify ?? "") && wantsNotice(d, m));
  // Title and click go in the query string: HTTP headers must be Latin-1, and titles hold "→", emoji and Turkish.
  // Tapping the notification opens the OpenCommunicate app (opencommunicate:// is its link scheme).
  const qs = new URLSearchParams({ title, tags: "speech_balloon", click: "opencommunicate://open" }).toString();
  await Promise.all(targets.map((d) => f(`${d.notify}?${qs}`, { method: "POST", body }).catch(() => undefined)));
  return targets.length;
}
