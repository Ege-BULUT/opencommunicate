// The few things the page needs from the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("opencomDesktop", {
  signInPost: (url, body) => ipcRenderer.invoke("signin-post", url, body),
  badge: (n) => ipcRenderer.send("badge", n),
  focus: () => ipcRenderer.send("focus"),
  info: () => ipcRenderer.invoke("app-info"),
  onUpdateReady: (cb) => ipcRenderer.on("update-ready", (_e, version) => cb(version)),
  installUpdate: () => ipcRenderer.invoke("update-install"),
});
