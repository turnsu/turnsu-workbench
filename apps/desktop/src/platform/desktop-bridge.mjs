export const invoke = (operation, args) => window.turnsuDesktop.invoke(operation, args);
export const command = (method, args = {}) => invoke('local_command', { method, args });
export const listen = callback => Promise.resolve(window.turnsuDesktop.listen(callback));
export const beforeClose = callback => window.turnsuDesktop.beforeClose(callback);
