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
    status: "ready",
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
  const published = workspaceId && repositories.skillVersions?.getBySkillRef
    ? await repositories.skillVersions.getBySkillRef(skillRef.skillId, skillRef.version, { workspaceId, ...options })
    : null;
  if (published) {
    return { definition: projectPublishedSkillVersion(published), skillVersion: published };
  }

  const legacy = repositories.skills;
  if (!legacy?.get) return { definition: null, skillVersion: null };
  const definition = (await legacy.get(skillRef.skillId, skillRef.version, { workspaceId, ...options }))
    ?? (workspaceId ? await legacy.get(skillRef.skillId, skillRef.version, options) : null);
  return { definition, skillVersion: null };
}

export async function resolvePinnedSkillDefinition(options) {
  return (await resolvePinnedSkill(options)).definition;
}
