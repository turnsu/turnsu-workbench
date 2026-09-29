import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { loginNativeProduct } from '../agent-runtime/integrations/native/login.mjs';
import { readNativeProfile, openNativeProductSession } from '../agent-runtime/integrations/native/session.mjs';
import { assertProductOrigin } from '../agent-runtime/integrations/native/product-tools.mjs';

const messages = {
  native_authorization_timed_out: '连接已超时，请重新打开授权页面。',
  native_authorization_cancelled: '已取消连接。',
  native_product_origin_invalid: '请输入团队的 HTTPS 地址。本机开发服务可使用 localhost。',
  native_session_refresh_uncertain_login_again: '上次登录刷新未能确认，请在团队设置中撤销此设备连接后重新登录。',
  native_session_expired_login_again: '登录已过期，请重新授权此设备。',
  native_client_session_invalid: '此设备的连接已撤销，请重新授权。',
  product_client_transport_failed: '暂时无法连接团队，请检查网络后重试。本地工作不受影响。',
};
function cloudError(error) { return messages[error?.code] || messages[error?.message] || '未能完成团队连接，请检查地址、登录状态和项目权限后重试。'; }

// Owns only this desktop's native credential, never project membership or business truth.
export class DesktopCloud {
  constructor({ directory, notify = () => {}, fetch }) {
    this.path = join(directory, 'cloud-session.json'); this.notify = notify; this.fetch = fetch;
    this.state = { status: 'disconnected', origin: '', error: '', projects: [] };
    this.ready = this.restore();
  }
  changed() { this.notify({ type: 'cloud-changed' }); }
  snapshot() { return { ...this.state, projects: [...this.state.projects] }; }
  async restore() {
    try {
      const profile = await readNativeProfile(this.path);
      this.session = await openNativeProductSession(this.path, { fetch: this.fetch, recoverStaleLock: true, desktopControl: true });
      this.state = { ...this.state, status: 'connected', origin: profile.baseUrl };
    } catch (error) { if (error.code !== 'ENOENT') this.state = { ...this.state, status: 'error', error: cloudError(error) }; }
  }
  async connect(baseUrl) {
    await this.ready;
    if (this.session || this.login) throw new Error('已有团队连接或正在授权，请先断开或取消。');
    let origin;
    try { origin = assertProductOrigin(baseUrl); } catch { throw new Error(messages.native_product_origin_invalid); }
    this.controller = new AbortController();
    this.state = { status: 'connecting', origin, error: '', projects: [] }; this.changed();
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    this.login = loginNativeProduct({ baseUrl: origin, sessionPath: this.path, fetch: this.fetch,
      signal: this.controller.signal, callbackMessage: '授权已接收，请回到 Turnsu 桌面查看连接结果。',
      onAuthorization: (url) => { this.authorizationUrl = url; started(this.snapshot()); this.changed(); },
    }).then(async () => {
      this.session = await openNativeProductSession(this.path, { fetch: this.fetch, recoverStaleLock: true, desktopControl: true });
      this.controller = null;
      this.state = { ...this.state, status: 'connected', error: '' };
      await this.projects();
    }).catch((error) => {
      const cancelled = this.controller?.signal.aborted;
      this.state = { ...this.state, status: cancelled ? 'disconnected' : 'error', error: cancelled ? '' : cloudError(error) };
    }).finally(() => { this.login = null; this.authorizationUrl = null; started(this.snapshot()); this.changed(); });
    return waiting;
  }
  async cancel() { this.controller?.abort(); await this.login; return this.snapshot(); }
  async projects(cursor) {
    await this.ready;
    if (!this.session) throw new Error('请先连接团队。');
    const session = this.session;
    try {
      const result = await session.product.call('turnsu_projects', cursor ? { query: { cursor } } : {}, { signal: AbortSignal.timeout(15_000) });
      if (this.session !== session) return this.snapshot();
      const projects = cursor ? [...new Map([...this.state.projects, ...result.data].map(p => [p.projectId, p])).values()] : result.data;
      this.state = { ...this.state, status: 'connected', error: '', projects, nextCursor: result.page?.nextCursor || null };
    } catch (error) {
      if (this.session !== session) return this.snapshot();
      // Do not present cached membership as current authorization after a failed read.
      this.state = { ...this.state, status: 'unavailable', projects: [], error: cloudError(error) };
      if (error.status === 401 || ['native_session_refresh_uncertain_login_again', 'native_session_expired_login_again'].includes(error.message)) {
        await this.session.release(); this.session = null; await unlink(this.path);
        this.state = { ...this.state, status: 'disconnected', error: '此设备的登录已失效，请重新连接团队。' };
      }
    }
    this.changed(); return this.snapshot();
  }
  async project(projectId) {
    await this.ready;
    if (!this.session) throw new Error('请先连接团队。');
    const session = this.session;
    try {
      const result = await session.product.call('turnsu_project', { pathParams: { projectId } }, { signal: AbortSignal.timeout(15_000) });
      if (this.session !== session) throw new Error('connection_changed');
      return result.data;
    }
    catch (error) { throw new Error(cloudError(error)); }
  }
  async identity() {
    await this.ready;
    if (!this.session) throw new Error('sync_login_required');
    let profile;
    try { profile = await readNativeProfile(this.path); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('sync_login_required'); throw error; }
    return { origin: profile.baseUrl, workspaceId: profile.tokens.workspaceId, clientSessionId: profile.tokens.clientSessionId };
  }
  async viewer() {
    await this.ready;
    if (!this.session) throw new Error('sync_login_required');
    const session = this.session;
    if (this.viewerSession === session) return this.viewerValue;
    const value = await session.viewer();
    if (this.session !== session) throw new Error('sync_connection_changed');
    this.viewerSession = session; this.viewerValue = value; return value;
  }
  async fileCall(identity, name, input) {
    const current = await this.identity(), session = this.session;
    if (JSON.stringify(current) !== JSON.stringify(identity)) throw new Error('sync_connection_changed');
    const result = await session.product.call(name, input, { signal: AbortSignal.timeout(15_000) });
    if (this.session !== session) throw new Error('sync_connection_changed');
    return result;
  }
  async desktopCall(identity, operationId, input, { signal } = {}) {
    const current = await this.identity(), session = this.session;
    if (JSON.stringify(current) !== JSON.stringify(identity)) throw new Error('sync_connection_changed');
    if (!session.desktop) throw new Error('desktop_control_unavailable');
    const timeout = AbortSignal.timeout(15_000);
    const result = await session.desktop.call(operationId, input, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    if (this.session !== session) throw new Error('sync_connection_changed');
    return result;
  }
  async disconnect() {
    await this.ready;
    if (this.login) return this.cancel();
    if (this.session) {
      try { await this.session.revoke(); } catch (error) { throw new Error(cloudError(error)); }
      await this.session.release(); this.session = null;
    }
    this.state = { status: 'disconnected', origin: '', error: '', projects: [] }; this.changed(); return this.snapshot();
  }
  async close() { await this.ready; this.controller?.abort(); await this.login; await this.session?.release(); this.session = null; }
}
