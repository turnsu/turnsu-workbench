const clone = (value) => structuredClone(value);

// Product SkillVersion is the immutable source of truth. This projection only
// satisfies the existing compiler/runner SkillDefinition boundary during migration.
export function projectPublishedSkillVersion(version) {
  if (!version?.skillId || !version.version || !version.executionRef) return null;
  return {
    schemaVersion: version.schemaVersion,
    skillId: version.skillId,
    version: version.version,
    name: version.name,
    description: version.description,
    category: version.category,
    display: {
      defaultLocale: "en",
      localized: { en: { name: version.name, description: version.description } },
    },
    inputSchema: clone(version.inputSchema),
    outputSchema: clone(version.outputSchema),
    risk: clone(version.risk),
    dependencies: clone(version.dependencies),
    setupChecks: [{
      checkId: "published-validation",
      label: "Published validation",
      status: "passed",
      message: "This immutable Skill version passed publication validation.",
    }],
    executionRef: clone(version.executionRef),
    usageCount: 0,
    readiness: { status: "ready", diagnostics: [] },
    createdAt: version.publishedAt,
    updatedAt: version.publishedAt,
  };
}

export async function resolvePinnedSkill({ repositories, skillRef, workspaceId, options = {} }) {
  if (!workspaceId || !repositories.skillVersions?.getBySkillRef) {
    return { definition: null, skillVersion: null };
  }
  const published = await repositories.skillVersions.getBySkillRef(
    skillRef.skillId,
    skillRef.version,
    { workspaceId, ...options },
  );
  return published
    ? { definition: projectPublishedSkillVersion(published), skillVersion: published }
    : { definition: null, skillVersion: null };
}

export async function resolvePinnedSkillDefinition(options) {
  return (await resolvePinnedSkill(options)).definition;
}
