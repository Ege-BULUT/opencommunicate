/* OpenCommunicate desktop: the same app as the phone's, in a window. The page is served from app:// so it
   has a stable origin (its saved session lives there); links open in the browser. */
const { app, BrowserWindow, ipcMain, net, protocol, shell } = require("electron");
const path = require("node:path");
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
   the installer in the background and the page offers a restart (or it installs on quit). macOS can't do that
   without a paid Apple signature (Squirrel.Mac refuses unsigned apps), so there the page shows a download link
   for the new dmg instead, as the Android app does for its APK. */
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
ipcMain.handle("app-info", () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, selfUpdates: !!updater, updateReady }));
ipcMain.handle("update-install", () => { if (updateReady) { quitting = true; updater.quitAndInstall(true, true); } });

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
