const { contextBridge, ipcRenderer } = require('electron');
const operations = new Set(['local_command', 'open_project', 'import_files', 'open_project_file', 'reveal_project_file', 'open_cloud_authorization', 'connection_list', 'connection_save', 'connection_remove', 'connection_check', 'open_gateway', 'computer_install', 'computer_app_picker', 'background_settings', 'manus_authorize', 'manus_authorize_cancel', 'agent_connection_list', 'agent_connection_save', 'agent_connection_remove', 'agent_connection_check', 'open_agent_task', 'open_agent_guide', 'open_managed_authorization']);
contextBridge.exposeInMainWorld('turnsuDesktop', {
  platform: process.platform,
  invoke: (operation, args) => {
    if (!operations.has(operation)) return Promise.reject(new Error('不支持这个桌面操作。'));
    return ipcRenderer.invoke('desktop:invoke', operation, args).then(reply => {
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    });
  },
  listen: callback => {
    const handler = (_event, payload) => callback({ payload });
    ipcRenderer.on('desktop:host-event', handler);
    return () => ipcRenderer.removeListener('desktop:host-event', handler);
  },
  beforeClose: callback => {
    const handler = async (_event, id) => {
      try { await callback(); ipcRenderer.send('desktop:close-ready', { id, saved: true }); }
      catch { ipcRenderer.send('desktop:close-ready', { id, saved: false }); }
    };
    ipcRenderer.on('desktop:prepare-close', handler);
    return () => ipcRenderer.removeListener('desktop:prepare-close', handler);
  },
});
