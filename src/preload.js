'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, fn) => {
  const handler = (_event, ...args) => fn(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('sessions', {
  init: () => ipcRenderer.invoke('app:init'),
  presets: () => ipcRenderer.invoke('presets:list'),
  editPresets: () => ipcRenderer.invoke('presets:edit'),
  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),

  create: (opts) => ipcRenderer.invoke('session:create', opts),
  start: (opts) => ipcRenderer.invoke('session:start', opts),
  restart: (opts) => ipcRenderer.invoke('session:restart', opts),
  close: (id) => ipcRenderer.invoke('session:close', id),
  rename: (id, name) => ipcRenderer.invoke('session:rename', { id, name }),
  focus: (id) => ipcRenderer.send('session:focus', id),

  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),

  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),

  onData: (fn) => on('pty:data', fn),
  onStatus: (fn) => on('session:status', fn),
  onActivate: (fn) => on('session:activate', fn),
});
