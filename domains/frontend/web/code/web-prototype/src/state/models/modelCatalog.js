const CAPABILITIES = new Set(["chat", "tool_calling", "structured_output", "image_generation"]);

export function normalizeModelFilters({ capabilities = [], context = "", selectedRevisionId = "", readiness = "" } = {}) {
  return {
    capabilities: [...new Set(capabilities.filter((value) => CAPABILITIES.has(value)))].sort(),
    context: String(context || ""),
    selectedRevisionId: String(selectedRevisionId || ""),
    readiness: String(readiness || ""),
  };
}

export function modelRevision(profile) {
  return profile?.currentRevision || profile?.revision || null;
}

export function modelSupports(profile, requiredCapabilities = []) {
  const revision = modelRevision(profile);
  const available = new Set(revision?.capabilities || profile?.capabilities || []);
  return requiredCapabilities.every((capability) => available.has(capability));
}

export function modelSelectionValue(profile, selectionKind = "revision") {
  return selectionKind === "profile"
    ? profile?.profileId || ""
    : modelRevision(profile)?.revisionId || profile?.revisionId || "";
}

function historicalRevision(profile, selectedRevisionId) {
  if (!selectedRevisionId) return null;
  const candidates = [
    profile?.selectedRevision,
    profile?.historicalRevision,
    ...(profile?.revisions || []),
  ].filter(Boolean);
  return candidates.find((revision) => revision.revisionId === selectedRevisionId) || null;
}

function isSelectable(profile) {
  if (profile?.selectable !== undefined) return profile.selectable === true && profile.enabled !== false;
  return profile?.readiness === "ready" && profile.enabled !== false;
}

export function modelPickerOptions(profiles = [], {
  requiredCapabilities = [],
  selectionKind = "revision",
  selectedValue = "",
} = {}) {
  const options = profiles
    .filter((profile) => modelSupports(profile, requiredCapabilities))
    .map((profile) => {
      const revision = modelRevision(profile);
      const readiness = profile.readiness || "unavailable";
      return {
        value: modelSelectionValue(profile, selectionKind),
        profileId: profile.profileId,
        revisionId: revision?.revisionId || "",
        label: profile.displayName || revision?.modelDisplayName || profile.profileId,
        providerLabel: revision?.providerDisplay?.label || profile.providerDisplay?.label || "",
        revisionNumber: revision?.revisionNumber || null,
        capabilities: revision?.capabilities || [],
        readiness,
        disabled: !isSelectable(profile),
        historical: false,
        profile,
      };
    })
    .filter((option) => option.value);

  if (selectedValue && !options.some((option) => option.value === selectedValue)) {
    const owner = profiles.find((profile) => (
      profile.profileId === selectedValue
      || historicalRevision(profile, selectedValue)
    ));
    const revision = owner ? historicalRevision(owner, selectedValue) : null;
    options.unshift({
      value: selectedValue,
      profileId: owner?.profileId || "",
      revisionId: revision?.revisionId || (selectionKind === "revision" ? selectedValue : ""),
      label: owner?.displayName || revision?.modelDisplayName || selectedValue,
      providerLabel: revision?.providerDisplay?.label || "",
      revisionNumber: revision?.revisionNumber || null,
      capabilities: revision?.capabilities || [],
      readiness: "disabled",
      disabled: true,
      historical: true,
      profile: owner || null,
    });
  }
  return options;
}

export function defaultModelSelection(profiles = [], capability, selectionKind = "revision") {
  const preferred = profiles.find((profile) => (
    profile.defaultForCapabilities?.includes(capability)
    && isSelectable(profile)
  ));
  const available = preferred || profiles.find((profile) => (
    modelSupports(profile, [capability])
    && isSelectable(profile)
    && profile.readiness === "ready"
  )) || profiles.find((profile) => (
    modelSupports(profile, [capability])
    && isSelectable(profile)
  ));
  return modelSelectionValue(available, selectionKind);
}
