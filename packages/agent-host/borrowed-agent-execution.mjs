import { isDeepStrictEqual } from 'node:util';
import { BorrowedAgentAttempts } from './borrowed-agent-attempts.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const pathFor = ticket => ({ workItemId: ticket.workItemId, requestId: ticket.requestId });

/** Desktop/device transport for an already accepted ticket. No accept, publication or model tool.
 * Provider UI consent and the selected local model runtime are the caller's responsibility.
 * Product remains authoritative at every check and delivery; reconnect never repeats inference.
 */
export class BorrowedAgentExecution {
  constructor({ db, cloud, createExecution }) {
    this.cloud = cloud;
    this.attempts = new BorrowedAgentAttempts({ db, createExecution });
  }
  async bind(identity) {
    const current = await this.cloud.identity();
    if (!isDeepStrictEqual(current, identity)) fail('borrowed_execution_connection_changed');
    const viewer = await this.cloud.viewer();
    if (viewer.workspaceId !== identity.workspaceId) fail('borrowed_execution_connection_changed');
    return { origin: identity.origin, workspaceId: identity.workspaceId, providerUserId: viewer.userId };
  }
  async start({ identity, ticket }) {
    const scope = await this.bind(identity);
    if (ticket.providerUserId !== scope.providerUserId || ticket.workspaceId !== scope.workspaceId) fail('borrowed_execution_wrong_provider');
    const view = await this.attempts.execute({ identity: scope, ticket, authorize: async ({ ticket: frozen, signal }) => {
      const grant = await this.cloud.desktopCall(identity, 'checkMemberAgentExecution', { pathParams: pathFor(frozen) }, { signal });
      const lease = grant.data?.lease;
      return grant.data?.active === true && isDeepStrictEqual(grant.data.ticket, frozen)
        && typeof lease?.capabilityLeaseId === 'string' && lease.capabilityLeaseId.length > 0
        && lease.fence === frozen.fence && Date.parse(lease.expiresAt) > Date.now()
        && Date.parse(lease.expiresAt) <= Date.parse(frozen.expiresAt);
    } });
    if (['result_ready', 'failed', 'interrupted'].includes(view.state) && !view.receipt) return this.deliver({ identity, invocationId: ticket.invocationId });
    return view;
  }
  async deliver({ identity, invocationId }) {
    const scope = await this.bind(identity);
    return this.attempts.deliver({ identity: scope, invocationId, send: async ({ ticket, outcome, result, deliveryId }) => {
      const response = await this.cloud.desktopCall(identity, 'deliverMemberAgentOutput', { pathParams: pathFor(ticket), idempotencyKey: deliveryId,
        data: { invocationId, attemptId: ticket.attemptId, fence: ticket.fence, deliveryId, outcome, ...(outcome === 'result' ? { output: result.output } : {}) } });
      return response.data;
    } });
  }
  async view({ identity, invocationId }) { return this.attempts.view(await this.bind(identity), invocationId); }
  async stopLocal({ identity, invocationId }) { return this.attempts.cancel(await this.bind(identity), invocationId); }
  close() { return this.attempts.close(); }
}
