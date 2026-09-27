import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';

// Exercise the generated chunk, including its SDK resource lookup, without an account or inference.
// Pass the local-agent-host directory from the built app. Run after build-host.mjs.
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = resolve(desktop, '../../../../agent/code/agent-runtime/node_modules/@earendil-works');
const { ModelRuntime } = await import(pathToFileURL(join(sdk, 'pi-coding-agent/dist/index.js')));
const { InMemoryCredentialStore } = await import(pathToFileURL(join(sdk, 'pi-ai/dist/index.js')));
const { createFauxCore, fauxAssistantMessage } = await import(pathToFileURL(join(sdk, 'pi-ai/dist/providers/faux.js')));
const bundle = resolve(process.argv[2]);
const names = (await readdir(join(bundle, 'chunks'))).filter(name => /^borrowed-pi-runtime-.*\.mjs$/.test(name));
assert.equal(names.length, 1, 'build output must contain exactly one current borrowed runtime');
const { BorrowedPiRuntime } = await import(pathToFileURL(join(bundle, 'chunks', names[0])));
const directory = await mkdtemp('/private/tmp/turnsu-bundled-pi-');
let runtime, execution;
try {
  const provider = 'turnsu-bundle-test', modelId = 'controlled';
  const model = { id: modelId, name: 'Controlled provider', api: provider, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 };
  const faux = createFauxCore({ provider, modelId, models: [model], tokensPerSecond: 0 });
  runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(directory, 'models'), refreshOnCreate: false });
  await runtime.setRuntimeApiKey(provider, 'synthetic-key');
  runtime.registerProvider(provider, { api: provider, baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-key', streamSimple: faux.streamSimple, models: [model] });
  const service = new BorrowedPiRuntime({ directory, runtimeFactory: async () => runtime });
  assert.ok((await service.models()).some(item => item.provider === provider && item.modelId === modelId));
  const seen = [], stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => { seen.push(context.tools.map(tool => tool.name).sort()); return stream(model, context, options); };
  faux.setResponses([
    fauxAssistantMessage([{ type: 'toolCall', id: 'read', name: 'read_input', arguments: { id: 'request' } }], { stopReason: 'toolUse' }),
    fauxAssistantMessage([{ type: 'toolCall', id: 'write', name: 'write_result', arguments: { content: '打包后的 SDK 已完成本次声明文本处理。' } }], { stopReason: 'toolUse' }),
    fauxAssistantMessage([{ type: 'text', text: '完成。' }], { stopReason: 'stop' }),
  ]);
  execution = await service.create({ authorize: async () => true, ticket: { selectedModel: { provider, modelId }, attemptId: 'packaged-attempt', instructions: '整理本次文本。', inputs: [{ id: 'request', title: '测试资料', text: '同事希望接续工作。' }], expiresAt: new Date(Date.now() + 30000).toISOString(), limits: { timeoutMs: 30000, maxModelRequests: 3, maxOutputTokens: 512, maxOutputBytes: 2000 } } });
  const result = await execution.run();
  assert.match(result.output, /打包后的 SDK/);
  assert.equal(result.modelRequests, 3);
  for (const tools of seen) assert.deepEqual(tools, ['read_input', 'write_result']);
  await execution.dispose();
  assert.ok(!(await readdir(directory)).some(name => name.startsWith('borrowed-text-')));
  console.log('Packaged Pi SDK: declared input → bounded result passed with controlled provider; private execution directory removed. No real model call.');
} finally {
  await execution?.dispose();
  runtime?.unregisterProvider('turnsu-bundle-test');
  await rm(directory, { recursive: true, force: true });
}
