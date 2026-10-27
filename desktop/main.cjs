/* OpenCommunicate desktop: the same app as the phone's, in a window. The page is served from app:// so it
   has a stable origin (its saved session lives there); links open in the browser. */
const { app, BrowserWindow, ipcMain, net, protocol, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "app");
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();
let win = null;
let quitting = false;

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 360, minHeight: 480, title: "OpenCommunicate", show: false,
    backgroundColor: "#f5f3ee",
    // polling keeps going while the window is hidden or minimised, so messages and notifications still arrive
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.removeMenu();
  win.loadURL("app://opencommunicate/index.html");
  win.once("ready-to-show", () => win.show());
  const external = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("app://")) { e.preventDefault(); external(url); } });
  // macOS: closing the window keeps the app (and the chat) running; the Dock icon brings it back
  win.on("close", (e) => { if (process.platform === "darwin" && !quitting) { e.preventDefault(); win.hide(); } });
  win.on("closed", () => { win = null; });
}

app.on("second-instance", show);
app.on("activate", show);
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

app.whenReady().then(() => {
  protocol.handle("app", (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(ROOT, rel === "/" ? "index.html" : rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

/* Updates. Windows updates itself: electron-updater reads latest.yml from the newest GitHub release, downloads
   the installer in the background and the page offers a restart (or it installs on quit). macOS has no Squirrel
   for an app without a paid Apple signature, so the Mac app replaces itself: the page finds the new dmg in the
   newest release, this downloads it, and once the app has quit a small script copies the new app over this one
   and opens it. OC_UPDATE_FEED (tests) points the page at another "newest release" and allows its downloads. */
let updateReady = null; // the version downloaded and waiting for a restart
let updater = null;
if (app.isPackaged && process.platform === "win32") {
  ({ autoUpdater: updater } = require("electron-updater"));
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("update-downloaded", (info) => { updateReady = info.version; win?.webContents.send("update-ready", info.version); });
  updater.on("error", () => {}); // offline, rate-limited: the next check tries again
  const check = () => updater.checkForUpdates().catch(() => {});
  app.whenReady().then(() => { setTimeout(check, 15_000); setInterval(check, 6 * 3600_000); });
}
const FEED = process.env.OC_UPDATE_FEED;
const macUpdates = app.isPackaged && process.platform === "darwin";
ipcMain.handle("app-info", () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, selfUpdates: !!updater, macUpdates, updateReady, feed: FEED }));
ipcMain.handle("update-install", () => { if (updateReady) { quitting = true; updater.quitAndInstall(true, true); } });
ipcMain.handle("update-mac", async (_e, url) => {
  const ours = /^https:\/\/github\.com\/Ege-BULUT\/opencommunicate\/releases\/download\/v[\d.]+\/OpenCommunicate-[\d.]+-mac-(arm64|x64)\.dmg$/.test(url) || (FEED && new URL(url).origin === new URL(FEED).origin);
  if (!macUpdates || !ours) throw new Error("Not an OpenCommunicate release.");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-update-"));
  const dmg = path.join(dir, "update.dmg");
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`The download failed (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(dmg);
  let got = 0, told = 0;
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    got += chunk.length;
    if (total && got - told > total / 100) { told = got; win?.webContents.send("update-progress", got / total); }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  const bundle = path.resolve(process.execPath, "../../.."); // …/OpenCommunicate.app
  fs.writeFileSync(path.join(dir, "swap.sh"), SWAP);
  spawn("/bin/sh", [path.join(dir, "swap.sh"), String(process.pid), dmg, bundle, dir], { detached: true, stdio: "ignore" }).unref();
  quitting = true;
  app.quit();
});
// $1 the app's pid, $2 the new dmg, $3 the app bundle, $4 a work folder. The old app stays unless the new one is
// fully copied, and whichever is there is opened again.
const SWAP = `while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
if hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$4/mnt" "$2" >/dev/null; then
  new=$(ls -d "$4"/mnt/*.app | head -n 1)
  if [ -n "$new" ] && ditto "$new" "$3.new"; then
    rm -rf "$3.old"
    if mv "$3" "$3.old"; then
      if mv "$3.new" "$3"; then rm -rf "$3.old"; else mv "$3.old" "$3"; fi
    fi
  fi
  rm -rf "$3.new"
  hdiutil detach "$4/mnt" -quiet
fi
xattr -dr com.apple.quarantine "$3" 2>/dev/null
open "$3"
rm -rf "$4"
`;

// github.com's sign-in endpoints refuse browser (CORS) requests, so the main process makes those two calls
const SIGN_IN = /^https:\/\/github\.com\/login\/(device\/code|oauth\/access_token)$/;
ipcMain.handle("signin-post", async (_e, url, body) => {
  if (!SIGN_IN.test(url)) throw new Error("Only GitHub sign-in goes through here.");
  // a renewal holds the account's lock in the page, so a hung request gives up (a renewal waits longer: GitHub
  // rotates the refresh token on use, and an answer given up on means signing in again)
  const res = await fetch(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(body?.grant_type === "refresh_token" ? 60_000 : 15_000) });
  try { return await res.json(); } catch { throw new Error(`GitHub ${res.status}`); }
});
ipcMain.on("badge", (_e, n) => app.setBadgeCount(Math.max(0, Number(n) || 0)));
ipcMain.on("focus", show);
