import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentKernelError,
  MinimalKernelContext,
  createDynamicPluginHost,
  createPluginProposalRegistry,
} from "../src/index.mjs";

const hash = `sha256:${"b".repeat(64)}`;

test("ephemeral Plugin evidence promotes only through a human-approved, capability-subset signed T3 descriptor", async (t) => {
  let tick = 0;
  const registry = createPluginProposalRegistry({
    idFactory: (kind) => `${kind}-${++tick}`,
    clock: () => "2026-08-14T00:00:00.000Z",
    signatureIssuer: async (release) => ({
      keyId: "workspace-key-1",
      value: `signature_${release.contentHash.slice("sha256:".length)}`,
    }),
  });
  const proposal = registry.propose({
    candidate: {
      pluginId: "sandbox-research-helper",
      version: "1",
      contentHash: hash,
      requestedCapabilities: ["read.evidence", "render.intent"],
      origin: "sandbox_ephemeral",
    },
    evidenceRefs: ["evidence-run-1"],
    authorRef: "principal-author",
  });
  await assert.rejects(
    () => registry.approve({
      proposalId: proposal.proposalId,
      reviewerRef: "principal-reviewer",
      approvedCapabilities: ["host.shell"],
    }),
    code("plugin_proposal_capability_expansion_forbidden"),
  );
  const approved = await registry.approve({
    proposalId: proposal.proposalId,
    reviewerRef: "principal-reviewer",
    approvedCapabilities: ["read.evidence"],
  });
  assert.equal(approved.release.trust, "T3");
  assert.deepEqual(approved.release.allowedCapabilities, ["read.evidence"]);
  const revision = registry.createPluginSetRevision({ proposalIds: [proposal.proposalId] });
  assert.equal(revision.activation, "requires_profile_resolver_and_sandbox");

  const root = new MinimalKernelContext({ scope: "plugin-promotion-test" });
  const host = createDynamicPluginHost({
    context: root,
    mode: "developer_dynamic",
    allowedCapabilities: ["read.evidence"],
    signatureVerifier: async (manifest) => (
      manifest.signature.keyId === approved.release.signature.keyId
      && manifest.signature.value === approved.release.signature.value
    ),
  });
  t.after(async () => { await host.dispose(); await root.dispose(); });
  await host.load({
    id: approved.release.pluginId,
    version: approved.release.version,
    trust: "T3",
    lifetime: "profile",
    contentHash: approved.release.contentHash,
    signature: approved.release.signature,
    capabilities: approved.release.allowedCapabilities,
    provides: ["workspace.research_helper"],
    setup(ctx) { ctx.provide("workspace.research_helper", { sourceProposalId: proposal.proposalId }); },
  });
  assert.deepEqual(root.use("workspace.research_helper"), { sourceProposalId: proposal.proposalId });
});

test("promotion records cannot be auto-released after rejection", () => {
  const registry = createPluginProposalRegistry({
    idFactory: (kind) => `${kind}-fixed`,
    clock: () => "2026-08-14T00:00:00.000Z",
    signatureIssuer: async () => ({ keyId: "key-fixed", value: "signature_fixed_value" }),
  });
  const proposal = registry.propose({
    candidate: {
      pluginId: "sandbox-rejected-helper",
      version: "1",
      contentHash: hash,
      requestedCapabilities: [],
      origin: "sandbox_ephemeral",
    },
    evidenceRefs: [],
    authorRef: "principal-author",
  });
  const rejected = registry.reject({
    proposalId: proposal.proposalId,
    reviewerRef: "principal-reviewer",
    reason: "Needs isolated evidence.",
  });
  assert.equal(rejected.status, "rejected");
  assert.throws(
    () => registry.createPluginSetRevision({ proposalIds: [proposal.proposalId] }),
    code("plugin_set_revision_unapproved_proposal"),
  );
});

function code(expected) {
  return (error) => error instanceof AgentKernelError && error.code === expected;
}
