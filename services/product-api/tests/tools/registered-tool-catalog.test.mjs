import assert from "node:assert/strict";
import test from "node:test";

import { createRegisteredToolCatalog } from "../../src/tools/registered-tool-catalog.mjs";
import { getLarkToolPolicy } from "../../src/tools/lark-tool-policy.mjs";

test("registered Tool catalog exposes only exact Product Gateway Action IDs", () => {
  const catalog = createRegisteredToolCatalog();

  assert.ok(catalog.length >= 5);
  for (const toolPackage of catalog) {
    assert.equal(toolPackage.registrationStatus, "registered");
    assert.match(toolPackage.skillName, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(toolPackage.actions.length > 0);
    assert.equal("command" in toolPackage, false);
    assert.equal("args" in toolPackage, false);
    assert.equal("connection" in toolPackage, false);
    for (const action of toolPackage.actions) {
      const policy = getLarkToolPolicy(action.actionId, toolPackage.skillName);
      assert.ok(policy, `${toolPackage.skillName}:${action.actionId} must be registered`);
      assert.ok(policy.skillNames.includes(toolPackage.skillName));
      assert.equal(action.effect, policy.effect);
      assert.equal(action.confirmationRequired, policy.confirmationRequired);
      assert.deepEqual(Object.keys(action).sort(), [
        "actionId",
        "confirmationRequired",
        "effect",
      ]);
    }
  }
});

test("registered Tool catalog is immutable and deterministic", () => {
  assert.deepEqual(createRegisteredToolCatalog(), createRegisteredToolCatalog());
  assert.ok(Object.isFrozen(createRegisteredToolCatalog()));
  assert.ok(createRegisteredToolCatalog().every((entry) => (
    Object.isFrozen(entry) && Object.isFrozen(entry.actions)
  )));
});
