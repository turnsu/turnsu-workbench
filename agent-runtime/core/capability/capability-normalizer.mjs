export function normalizeSelectedCapabilities({
  selectedCapabilityIDs = [],
  selectedSkillIDs = [],
  selectedExtensionIDs = [],
  capabilityCatalog = null,
} = {}) {
  const catalogCapabilities = Array.isArray(capabilityCatalog?.capabilities) ? capabilityCatalog.capabilities : [];
  const selectedCapabilitySet = new Set(safeArray(selectedCapabilityIDs).map(normalizeID).filter(Boolean));
  const selectedSkillSet = new Set(safeArray(selectedSkillIDs).map(normalizeID).filter(Boolean));
  const selectedExtensionSet = new Set(safeArray(selectedExtensionIDs).map(normalizeID).filter(Boolean));
  const matchedCapabilities = [];
  const unknownCapabilityIDs = [];

  for (const capabilityID of selectedCapabilitySet) {
    const capability = catalogCapabilities.find((item) => item.capabilityID === capabilityID);
    if (capability) {
      matchedCapabilities.push(capability);
    } else {
      unknownCapabilityIDs.push(capabilityID);
    }
  }

  for (const capability of catalogCapabilities) {
    const skillMatch = safeArray(capability.legacySkillIDs).some((skillID) => selectedSkillSet.has(skillID));
    const extensionMatch = safeArray(capability.legacyExtensionIDs).some((extensionID) => selectedExtensionSet.has(extensionID));
    if ((skillMatch || extensionMatch) && !matchedCapabilities.some((item) => item.capabilityID === capability.capabilityID)) {
      matchedCapabilities.push(capability);
    }
  }

  for (const capability of matchedCapabilities) {
    for (const skillID of safeArray(capability.legacySkillIDs)) selectedSkillSet.add(skillID);
    for (const extensionID of safeArray(capability.legacyExtensionIDs)) selectedExtensionSet.add(extensionID);
  }

  const normalizedCapabilityIDs = [
    ...matchedCapabilities.map((item) => item.capabilityID),
    ...unknownCapabilityIDs,
  ].map((item) => String(item || "").trim()).filter(Boolean);
  return {
    selectedCapabilityIDs: [...new Set(normalizedCapabilityIDs)],
    resolvedCapabilityIDs: matchedCapabilities.map((item) => item.capabilityID),
    unknownCapabilityIDs,
    legacySelectedSkillIDs: [...selectedSkillSet],
    legacySelectedExtensionIDs: [...selectedExtensionSet],
    compatibilityMode: selectedCapabilitySet.size ? "capability_catalog_v1" : "legacy_skill_extension_ids",
  };
}

export function buildRouteContext({
  prompt,
  selectedToolNames = [],
  selectedSkillIDs = [],
  selectedExtensionIDs = [],
  selectedCapabilityIDs = [],
  attachments = [],
  contextRefs = [],
  capabilityCatalog = null,
} = {}) {
  return {
    prompt: String(prompt || ""),
    selectedToolNames: safeArray(selectedToolNames),
    attachments: safeArray(attachments),
    contextRefs: safeArray(contextRefs),
    ...normalizeSelectedCapabilities({ selectedCapabilityIDs, selectedSkillIDs, selectedExtensionIDs, capabilityCatalog }),
  };
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeID(value) {
  return String(value || "").trim();
}
