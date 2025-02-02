// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// 使用 contextBridge 暴露方法給渲染進程
contextBridge.exposeInMainWorld('electron', {
  sendToMain: (message) => ipcRenderer.send('message-to-main', message),
  receiveFromMain: (callback) => ipcRenderer.on('message-from-main', callback),
});
