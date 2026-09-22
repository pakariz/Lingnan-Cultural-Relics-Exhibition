const { app, BrowserWindow } = require("electron");
const path = require("path");
const net = require("net");

let mainWindow = null;
let serverPort = null;

// 找一个空闲端口，避免与用户已开的 3000 端口冲突
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function startBackend() {
  // 在 require 后端之前写入端口，server.js 会读取 process.env.PORT
  return getFreePort().then((port) => {
    process.env.PORT = String(port);
    require(path.join(__dirname, "..", "backend", "server.js"));
    return port;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 620,
    title: "数字文物展馆",
    autoHideMenuBar: true,
    backgroundColor: "#0b0f16",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  serverPort = await startBackend();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});