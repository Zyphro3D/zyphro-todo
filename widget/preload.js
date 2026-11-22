const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('todo', {
  onState: f => ipcRenderer.on('state', (_, s) => f(s)),
  onOnline: f => ipcRenderer.on('online', (_, v) => f(v)),
  setStatus: (id, st) => ipcRenderer.invoke('task-status', id, st),
  add: (project, title) => ipcRenderer.invoke('task-add', project, title),
  api: (p, body) => ipcRenderer.invoke('api', p, body),
  hide: () => ipcRenderer.invoke('hide'),
});
