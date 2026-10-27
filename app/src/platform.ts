/* Phone-only bits behind one interface: local notifications, saving attachments, opening links. On the
   desktop the browser does all three itself. */
import { Browser } from "@capacitor/browser";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import { registerPlugin } from "@capacitor/core";
import { fromBase64, toBase64 } from "../../core/src/index.ts";
import { desktopApp, native } from "./session.ts";

let nextId = 1;

export async function askNotifications(): Promise<void> {
  if (native()) await LocalNotifications.requestPermissions().catch(() => undefined);
  else if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
}

export async function notify(title: string, body: string): Promise<void> {
  if (native()) {
    await LocalNotifications.schedule({ notifications: [{ id: nextId++, title, body }] }).catch(() => undefined);
  } else if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification(title, { body });
    n.onclick = () => { desktopApp()?.focus(); window.focus(); };
  }
}

/** Opens a link: on the phone in a Chrome tab over the app, or with `inApp` false in the browser itself. An APK
 *  download that GitHub redirects stalled at 100% in such a tab on a phone (2026-10-21), so the update link goes
 *  to the browser, where GitHub's downloads work. */
export async function openLink(url: string, inApp = true): Promise<void> {
  // app links (ntfy://…) go straight to Android, which opens the app that owns them; so does a web link the
  // app's own page doesn't load (Capacitor hands it to the browser)
  if (native() && (!/^https?:/.test(url) || !inApp)) { location.href = url; return; }
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

/** A name for a pasted image, which comes without one of its own ("image.png"): image-20261027085850.png. */
export const pastedName = (type: string, i = 0) => `image-${new Date().toLocaleString("sv").replace(/\D/g, "")}${i ? `-${i + 1}` : ""}.${type.split("/")[1]?.split("+")[0] || "png"}`;

// The phone's text box offers no Paste for a copied image (a screenshot, an image copied in another app), and the
// page may not read the clipboard, so the app's own plugin does (ClipboardImagePlugin.java).
const ClipboardImage = registerPlugin<{ has(): Promise<{ image: boolean }>; read(): Promise<{ type?: string; data?: string }> }>("ClipboardImage");
/** Phone: whether the clipboard holds an image. */
export const copiedImage = async () => native() && (await ClipboardImage.has().catch(() => ({ image: false }))).image;
/** Phone: the clipboard's image as a file, or null when it holds none. */
export async function pasteImage(): Promise<File | null> {
  const { type, data } = await ClipboardImage.read();
  return type && data ? new File([fromBase64(data) as BlobPart], pastedName(type), { type }) : null;
}
