// Narrow, typed bridge between the renderer and the main process. No Node access in the page.
const { contextBridge, ipcRenderer } = require('electron');

const PUSH = new Set(['state', 'open-request', 'theme', 'settings', 'window-mode', 'run-ended', 'reveal', 'setup']);

contextBridge.exposeInMainWorld('layover', {
  getState: () => ipcRenderer.invoke('state:get'),
  getUser: (project) => ipcRenderer.invoke('user:get', project),
  setNotes: (project, body, revision) => ipcRenderer.invoke('user:notes', { project, body, revision }),
  upsertTicket: (project, ticket) => ipcRenderer.invoke('user:ticket', { project, ticket }),
  deleteTicket: (project, id) => ipcRenderer.invoke('user:ticket:delete', { project, id }),
  respond: (project, key, body) => ipcRenderer.invoke('user:respond', { project, key, body }),
  dismiss: (project, key, dismissed) => ipcRenderer.invoke('user:dismiss', { project, key, dismissed }),
  setPlace: (project, place) => ipcRenderer.invoke('user:place', { project, place }),
  setProjectMeta: (project, meta) => ipcRenderer.invoke('project:meta', { project, meta }),
  createProject: (name, folder) => ipcRenderer.invoke('project:create', { name, folder }),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  setupStatus: () => ipcRenderer.invoke('setup:status'),
  setupInstall: (agent, options) => ipcRenderer.invoke('setup:install', { agent, options }),
  setupRemove: (agent) => ipcRenderer.invoke('setup:remove', agent),
  setWindowMode: (mode) => ipcRenderer.invoke('window:mode', mode),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  returnFocus: (taskId) => ipcRenderer.invoke('return:focus', taskId),
  sendMessage: (m) => ipcRenderer.invoke('outbox:send', m),
  cancelMessage: (id) => ipcRenderer.invoke('outbox:cancel', id),
  bridgeTarget: (run) => ipcRenderer.invoke('bridge:target', run),
  bridgeSend: (payload) => ipcRenderer.invoke('bridge:send', payload),
  engaged: (flag) => ipcRenderer.send('ui:engaged', !!flag),
  on: (channel, fn) => {
    if (!PUSH.has(channel)) throw Error('Unknown channel ' + channel);
    const wrapped = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
