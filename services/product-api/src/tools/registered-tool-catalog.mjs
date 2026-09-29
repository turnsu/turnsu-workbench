import { LARK_TOOL_POLICIES } from "./lark-tool-policy.mjs";

const PACKAGE_COPY = Object.freeze({
  "lark-calendar": Object.freeze({
    label: "Lark Calendar",
    description: "Read governed calendar availability and create events after confirmation.",
  }),
  "lark-task": Object.freeze({
    label: "Lark Tasks",
    description: "Read assigned tasks and create governed follow-up tasks after confirmation.",
  }),
  "lark-im": Object.freeze({
    label: "Lark Messages",
    description: "Search team messages and send a governed message after confirmation.",
  }),
  "lark-doc": Object.freeze({
    label: "Lark Documents",
    description: "Read approved Lark documents through the product Tool Gateway.",
  }),
  "lark-minutes": Object.freeze({
    label: "Lark Minutes",
    description: "Search approved meeting minutes through the product Tool Gateway.",
  }),
});

export function createRegisteredToolCatalog() {
  const actionsBySkill = new Map();
  for (const policy of LARK_TOOL_POLICIES) {
    for (const skillName of policy.skillNames) {
      if (!actionsBySkill.has(skillName)) actionsBySkill.set(skillName, []);
      actionsBySkill.get(skillName).push(Object.freeze({
        actionId: policy.action,
        effect: policy.effect,
        confirmationRequired: policy.confirmationRequired,
      }));
    }
  }
  return Object.freeze([...actionsBySkill.entries()]
    .filter(([skillName]) => PACKAGE_COPY[skillName])
    .map(([skillName, actions]) => Object.freeze({
      toolPackageId: `registered:${skillName}`,
      skillName,
      label: PACKAGE_COPY[skillName].label,
      description: PACKAGE_COPY[skillName].description,
      registrationStatus: "registered",
      actions: Object.freeze(actions.sort((left, right) => left.actionId.localeCompare(right.actionId))),
    }))
    .sort((left, right) => left.label.localeCompare(right.label)));
}
