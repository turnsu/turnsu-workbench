import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSupportedNodeVersion,
  nodeVersionSatisfiesRuntime,
} from "../../src/runtime/node-version-gate.mjs";

test("server rejects Node versions below 22.19.0", () => {
  assert.equal(nodeVersionSatisfiesRuntime("22.18.9"), false);
  assert.equal(nodeVersionSatisfiesRuntime("22.19.0"), true);
  assert.equal(nodeVersionSatisfiesRuntime("22.22.3"), true);
  assert.throws(() => assertSupportedNodeVersion("v20.19.0"), /unsupported_node_version/);
});
