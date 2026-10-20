// Fixed public media providers used by the copied OpenUI library. No local
// network, arbitrary URL proxy, account cookie, filesystem, or host IPC.
export const uiCsp = {
  connectDomains: ['https://tiles.openfreemap.org', 'https://server.arcgisonline.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://esm.sh'],
  resourceDomains: ['data:', 'https://upload.wikimedia.org', 'https://thumb.wikimedia.org', 'https://images.unsplash.com', 'https://tiles.openfreemap.org', 'https://server.arcgisonline.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com', 'https://esm.sh', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
  frameDomains: ['https://www.youtube-nocookie.com'],
};
export const nativeUiCsp = `default-src 'none'; script-src 'unsafe-inline' blob: ${uiCsp.resourceDomains.join(' ')}; worker-src blob: data:; style-src 'unsafe-inline' ${uiCsp.resourceDomains.join(' ')}; font-src 'self' data: https://fonts.gstatic.com; img-src data: blob: ${uiCsp.resourceDomains.join(' ')}; connect-src ${uiCsp.connectDomains.join(' ')}; object-src 'none'; frame-src 'self' blob: ${uiCsp.frameDomains.join(' ')}; base-uri 'none'; form-action 'none'`;
