import { runContainerPiWorker } from "./container-pi-worker.mjs";
import { ContainerWorkerProtocol } from "./container-worker-protocol.mjs";

const protocol = new ContainerWorkerProtocol();

try {
  const payload = await protocol.waitForStart();
  const result = await runContainerPiWorker(payload, protocol);
  const { workerTranscript, ...publicResult } = result;
  if (workerTranscript) await protocol.sendTranscript(workerTranscript);
  await protocol.sendResult(publicResult);
} catch (error) {
  if (error?.workerTranscript) await protocol.sendTranscript(error.workerTranscript);
  await protocol.sendResult({
    status: ["blocked", "permission_denied", "timeout", "cancelled"].includes(error?.status) ? error.status : "failed",
    summary: safeMessage(error),
    evidence: [],
    usage: error?.usage ?? { steps: 0, modelRequests: 0, inputBytes: 0, outputBytes: 0 },
  }).catch(() => { process.exitCode = 1; });
} finally {
  protocol.dispose();
}

function safeMessage(error) {
  if (error?.productSafe === true && typeof error.message === "string") return error.message.slice(0, 4000);
  return "Agent Worker failed.";
}
