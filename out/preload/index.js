"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("api", {});
