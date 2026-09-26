/* Phone-only bits behind one interface: local notifications, saving attachments, opening links. On the
   desktop the browser does all three itself. */
import { Browser } from "@capacitor/browser";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import { toBase64 } from "../../core/src/index.ts";
import { native } from "./session.ts";

let nextId = 1;

export async function askNotifications(): Promise<void> {
  if (native()) await LocalNotifications.requestPermissions().catch(() => undefined);
  else if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
}

export async function notify(title: string, body: string): Promise<void> {
  if (native()) {
    await LocalNotifications.schedule({ notifications: [{ id: nextId++, title, body }] }).catch(() => undefined);
  } else if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

export async function openLink(url: string): Promise<void> {
  // app links (ntfy://…) go straight to Android, which opens the app that owns them
  if (native() && !/^https?:/.test(url)) { location.href = url; return; }
  if (native()) await Browser.open({ url });
  else window.open(url, "_blank", "noopener");
}

/** Hands a received file to the person: a download on the desktop, the share sheet on the phone. */
export async function saveFile(name: string, data: Uint8Array): Promise<void> {
  if (native()) {
    const path = `opencommunicate/${Date.now()}-${name}`;
    const { uri } = await Filesystem.writeFile({ path, data: toBase64(data), directory: Directory.Cache, recursive: true });
    await Share.share({ title: name, url: uri, dialogTitle: name });
    return;
  }
  const url = URL.createObjectURL(new Blob([data as BlobPart]));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const imageUrl = (name: string, data: Uint8Array) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const type = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext];
  return type ? URL.createObjectURL(new Blob([data as BlobPart], { type })) : null;
};
