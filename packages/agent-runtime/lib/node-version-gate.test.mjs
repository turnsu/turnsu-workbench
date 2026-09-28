import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSupportedNodeVersion,
  nodeVersionSatisfiesRuntime,
} from "./node-version-gate.mjs";

test("runtime rejects Node versions below 22.19.0", () => {
  assert.equal(nodeVersionSatisfiesRuntime("v22.18.9"), false);
  assert.equal(nodeVersionSatisfiesRuntime("v22.19.0"), true);
  assert.equal(nodeVersionSatisfiesRuntime("v22.22.3"), true);
  assert.equal(nodeVersionSatisfiesRuntime("v23.0.0"), true);
  assert.throws(() => assertSupportedNodeVersion("v22.17.0"), /unsupported_node_version/);
});
