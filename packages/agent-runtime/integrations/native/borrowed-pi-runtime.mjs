import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRestrictedPiExecution } from './restricted-pi-execution.mjs';

// Read the member's configured Pi accounts only when the desktop asks for model selection.
// Personal native history/extensions/project settings are never loaded into the borrowed session.
export class BorrowedPiRuntime {
  constructor({ directory, runtimeFactory = options => ModelRuntime.create(options) }) { this.directory = directory; this.runtimeFactory = runtimeFactory; }
  async runtime() {
    if (!this.loading) this.loading = this.runtimeFactory({ allowModelNetwork: false, signal: AbortSignal.timeout(15000) }).catch(error => { this.loading = null; throw error; });
    return this.loading;
  }
  async models() {
    const runtime = await this.runtime();
    const models = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(15000) });
    // Subscription seats are not exposed as a pooled third-party execution service.
    return models.filter(model => model.input.includes('text') && !runtime.isUsingSubscription(model.provider))
      .map(model => ({ provider: model.provider, modelId: model.id, name: model.name || model.id }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  }
  async create({ ticket, authorize, signal }) {
    const runtime = await this.runtime(), available = await this.models();
    if (!available.some(item => item.provider === ticket.selectedModel.provider && item.modelId === ticket.selectedModel.modelId)) throw new Error('restricted_pi_model_unavailable');
    const model = runtime.getModel(ticket.selectedModel.provider, ticket.selectedModel.modelId);
    const folder = await mkdtemp(join(this.directory, 'borrowed-text-')), cwd = join(folder, 'work'), agentDir = join(folder, 'agent');
    let execution, disposed = false;
    const dispose = async () => { if (disposed) return; disposed = true; try { await execution?.dispose(); } finally { await rm(folder, { recursive: true, force: true }); } };
    try {
      await mkdir(cwd, { mode: 0o700 }); await mkdir(agentDir, { mode: 0o700 });
      execution = await createRestrictedPiExecution({ cwd, agentDir, modelRuntime: runtime, model, attemptId: ticket.attemptId,
        instructions: ticket.instructions, inputs: ticket.inputs, authorize, signal, expiresAt: Date.parse(ticket.expiresAt), ...ticket.limits });
      return { profile: execution.profile, run: () => execution.run(), cancel: () => execution.cancel(), dispose };
    } catch (error) { await dispose(); throw error; }
  }
}
