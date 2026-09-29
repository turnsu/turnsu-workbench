import { createHash } from 'node:crypto';

export const secretHash = value => createHash('sha256').update(value).digest('hex');
export class ConnectorError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const requireValue = (condition, message, status) => { if (!condition) throw new ConnectorError(message, status); };
