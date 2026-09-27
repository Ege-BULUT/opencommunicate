// The few things the page needs from the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("opencomDesktop", {
  signInPost: (url, body) => ipcRenderer.invoke("signin-post", url, body),
  badge: (n) => ipcRenderer.send("badge", n),
  focus: () => ipcRenderer.send("focus"),
});
