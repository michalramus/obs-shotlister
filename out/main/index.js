"use strict";
const electron = require("electron");
const path = require("path");
const express = require("express");
const http = require("http");
const ws = require("ws");
const router = express.Router();
router.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
function attachWebSocketServer(httpServer) {
  const wss = new ws.WebSocketServer({ server: httpServer });
  wss.on("connection", (socket) => {
    const initialState = JSON.stringify({ type: "state", payload: {} });
    socket.send(initialState);
  });
  return wss;
}
const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3e3;
function startServer() {
  const app = express();
  app.use(express.json());
  app.use(router);
  if (process.env["NODE_ENV"] !== "development") {
    app.use(express.static(path.join(__dirname, "../../web")));
  }
  const httpServer = http.createServer(app);
  attachWebSocketServer(httpServer);
  httpServer.listen(PORT, () => {
    console.info(`[server] listening on http://localhost:${PORT}`);
  });
}
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true
    }
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.app.whenReady().then(() => {
  startServer();
  createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
