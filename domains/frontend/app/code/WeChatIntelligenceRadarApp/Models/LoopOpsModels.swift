import Foundation

enum LoopOpsSurface: String, CaseIterable, Identifiable, Codable, Hashable {
    case workbench
    case library
    case skillOS
    case workforce
    case knowledge
    case studio
    case settings

    var id: String { rawValue }
}

enum ChatScope: String, CaseIterable, Identifiable, Codable, Hashable {
    case global
    case run
    case builder
    case review

    var id: String { rawValue }

    var title: String {
        switch self {
        case .global: return "Global Chat"
        case .run: return "Run Chat"
        case .builder: return "Builder Chat"
        case .review: return "Review Chat"
        }
    }
}

enum LoopContractRunMode: String, CaseIterable, Identifiable, Codable, Hashable {
    case manual
    case scheduled

    var id: String { rawValue }
}

enum LoopOpsSkillBindingKind: String, CaseIterable, Codable, Hashable {
    case skill
    case extensionPackage

    var title: String {
        switch self {
        case .skill:
            return "Skill"
        case .extensionPackage:
            return "Package"
        }
    }
}

struct LoopOpsSkillBinding: Identifiable, Codable, Hashable {
    var kind: LoopOpsSkillBindingKind
    var id: String
    var title: String
    var order: Int
    var required: Bool
    var enabled: Bool
    var source: String

    var dragID: String {
        "\(kind.rawValue):\(id)"
    }

    var pathLabel: String {
        "\(order + 1). \(title)"
    }

    init(
        kind: LoopOpsSkillBindingKind,
        id: String,
        title: String,
        order: Int,
        required: Bool = false,
        enabled: Bool = true,
        source: String = "manual"
    ) {
        self.kind = kind
        self.id = id
        self.title = title
        self.order = order
        self.required = required
        self.enabled = enabled
        self.source = source
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case id
        case title
        case order
        case required
        case enabled
        case source
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(LoopOpsSkillBindingKind.self, forKey: .kind)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        order = try container.decode(Int.self, forKey: .order)
        required = try container.decodeIfPresent(Bool.self, forKey: .required) ?? false
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        source = try container.decodeIfPresent(String.self, forKey: .source) ?? "manual"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(order, forKey: .order)
        try container.encode(required, forKey: .required)
        try container.encode(enabled, forKey: .enabled)
        try container.encode(source, forKey: .source)
    }
}

struct LoopOpsSkillStack: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var summary: String
    var bindings: [LoopOpsSkillBinding]
    var createdAt: Date
    var updatedAt: Date

    init(
        id: String = "skill-stack-\(UUID().uuidString)",
        name: String,
        summary: String,
        bindings: [LoopOpsSkillBinding],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.summary = summary
        self.bindings = LoopOpsSkillBinding.ordered(bindings)
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

enum LoopOpsSkillPathDropResolver {
    static func apply(
        payload: String,
        before beforeID: String?,
        to bindings: [LoopOpsSkillBinding],
        stacks: [LoopOpsSkillStack]
    ) -> [LoopOpsSkillBinding] {
        let parts = payload.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard let type = parts.first else {
            return LoopOpsSkillBinding.ordered(bindings)
        }

        if type == "loopops-stack", parts.count >= 2,
           let stack = stacks.first(where: { $0.id == parts[1] }) {
            return stack.bindings.reduce(LoopOpsSkillBinding.ordered(bindings)) { current, binding in
                insert(binding, before: beforeID, into: current)
            }
        }

        guard type == "loopops-skill", parts.count >= 4,
              let kind = LoopOpsSkillBindingKind(rawValue: parts[1]) else {
            return LoopOpsSkillBinding.ordered(bindings)
        }

        let binding = LoopOpsSkillBinding(
            kind: kind,
            id: parts[2],
            title: parts[3],
            order: bindings.count,
            source: "drag"
        )
        return insert(binding, before: beforeID, into: bindings)
    }

    static func insert(
        _ binding: LoopOpsSkillBinding,
        before beforeID: String?,
        into bindings: [LoopOpsSkillBinding]
    ) -> [LoopOpsSkillBinding] {
        if beforeID == binding.dragID {
            return LoopOpsSkillBinding.normalizeCurrentOrder(LoopOpsSkillBinding.ordered(bindings))
        }
        var next = LoopOpsSkillBinding.ordered(bindings)
            .filter { !($0.kind == binding.kind && $0.id == binding.id) }
        if let beforeID, let index = next.firstIndex(where: { $0.dragID == beforeID }) {
            next.insert(binding, at: index)
        } else {
            next.append(binding)
        }
        return LoopOpsSkillBinding.normalizeCurrentOrder(next)
    }
}

struct LoopOpsSkillPackage: Identifiable, Hashable {
    var kind: LoopOpsSkillBindingKind
    var id: String
    var title: String
    var description: String
    var status: String
    var selected: Bool
    var category: String?
    var integrationLabel: String = "Local Tool"
    var usedByLabel: String = "Available"
    var ownerLabel: String = "Workspace"
    var updatedLabel: String = "Available"
    var lastModifiedAt: Date?

    var dragPayload: String {
        [
            "loopops-skill",
            kind.rawValue,
            id,
            title.replacingOccurrences(of: "|", with: " "),
            category ?? ""
        ].joined(separator: "|")
    }

    var domainLabel: String {
        let value = "\(id) \(title) \(category ?? "")".lowercased()
        if value.contains("markets") || value.contains("equity") || value.contains("stock") || value.contains("sector") || value.contains("earnings") || value.contains("company") || value.contains("thesis") || value.contains("cross-asset") {
            return "Markets"
        }
        if value.contains("office") || value.contains("meeting") || value.contains("document") {
            return "Office"
        }
        if value.contains("cmc") || value.contains("market") || value.contains("token") || value.contains("wechat") || value.contains("onchain") || value.contains("crypto") {
            return "Crypto"
        }
        return "Local"
    }

    var isWorkbenchVisible: Bool {
        LoopOpsPublicSkillPolicy.isVisible(package: self)
    }

    func binding(order: Int, source: String = "skill-os") -> LoopOpsSkillBinding {
        LoopOpsSkillBinding(
            kind: kind,
            id: id,
            title: LoopOpsPublicSkillPolicy.publicFacing(title),
            order: order,
            required: selected,
            source: source
        )
    }

    @MainActor
    static func packages(from viewModel: DashboardViewModel) -> [LoopOpsSkillPackage] {
        let skills = viewModel.agentSkills.map { skill in
            LoopOpsSkillPackage(
                kind: .skill,
                id: skill.skillID,
                title: LoopOpsPublicSkillPolicy.publicFacing(skill.title),
                description: LoopOpsPublicSkillPolicy.publicFacing(skill.permissionSummary ?? skill.description),
                status: LoopOpsPublicSkillPolicy.publicFacing(skill.status),
                selected: viewModel.selectedAgentSkillIDs.contains(skill.skillID),
                category: skill.category,
                integrationLabel: LoopOpsPublicSkillPolicy.publicFacing(skill.category ?? "Skill OS"),
                usedByLabel: viewModel.selectedAgentSkillIDs.contains(skill.skillID) ? "Selected stack" : "Available",
                ownerLabel: "Workspace",
                updatedLabel: "Available"
            )
        }
        let extensions = viewModel.agentExtensions.map { item in
            LoopOpsSkillPackage(
                kind: .extensionPackage,
                id: item.extensionID,
                title: LoopOpsPublicSkillPolicy.publicFacing(item.title),
                description: LoopOpsPublicSkillPolicy.publicFacing(item.permissionSummary ?? item.description),
                status: LoopOpsPublicSkillPolicy.publicFacing(item.status),
                selected: viewModel.selectedAgentExtensionIDs.contains(item.extensionID),
                category: item.category,
                integrationLabel: LoopOpsPublicSkillPolicy.publicFacing(item.category ?? "Extension"),
                usedByLabel: viewModel.selectedAgentExtensionIDs.contains(item.extensionID) ? "Selected stack" : "Available",
                ownerLabel: "Workspace",
                updatedLabel: "Available"
            )
        }
        return (skills + extensions).filter(\.isWorkbenchVisible)
    }

    @MainActor
    static func packages(from viewModel: DashboardViewModel, toolDrafts: [LoopOpsToolDraft]) -> [LoopOpsSkillPackage] {
        let localDrafts = toolDrafts.map { draft in
            LoopOpsSkillPackage(
                kind: .skill,
                id: draft.id,
                title: LoopOpsPublicSkillPolicy.publicFacing(draft.name),
                description: LoopOpsPublicSkillPolicy.publicFacing("\(draft.purpose) · \(draft.resolvedInputScope) · \(draft.resolvedIntegrationSource)"),
                status: "Draft",
                selected: draft.isEnabled || viewModel.selectedLoopOpsToolDraftIDs.contains(draft.id),
                category: "Local Tool",
                integrationLabel: LoopOpsPublicSkillPolicy.publicFacing(draft.resolvedIntegrationSource),
                usedByLabel: draft.skillBindings.isEmpty ? "Skill OS" : "\(draft.skillBindings.count) actions",
                ownerLabel: "You",
                updatedLabel: draft.updatedAt.formatted(date: .abbreviated, time: .omitted),
                lastModifiedAt: draft.updatedAt
            )
        }
        return localDrafts + packages(from: viewModel)
    }
}

struct LoopOpsTemplateListing: Identifiable, Hashable {
    enum Source: String, Hashable {
        case starter = "Marketplace"
        case saved = "Saved"
        case imported = "Imported"
    }

    var id: String
    var contract: LoopContract
    var source: Source
    var creatorLabel: String
    var installLabel: String
    var readinessLabel: String
    var exampleTask: String
    var requirementLabels: [String]
    var templateTypeLabel: String
    var categoryLabel: String
    var accessLabel: String
    var updatedLabel: String
    var integrationLabels: [String]
    var requiredInputLabels: [String]
    var requiredKnowledgeLabels: [String]
    var tagLabels: [String]
    var readinessChecklist: [String]
    var stepPreview: [String]
    var workspaceCopyID: String?

    var title: String { contract.name }
    var domain: WorkbenchDomain { contract.domain }
    var summary: String { contract.goal }
    var skillPath: String { contract.orderedSkillPathLabels.joined(separator: " -> ") }
    var isInstallable: Bool { source == .starter && workspaceCopyID == nil }

    static func from(
        contract: LoopContract,
        savedIDs: Set<String>,
        workspaceCopyIDsByTemplateID: [String: String] = [:]
    ) -> LoopOpsTemplateListing {
        let source: Source = savedIDs.contains(contract.id) ? .saved : .starter
        let workspaceCopyID = contract.workspaceCopyID ?? workspaceCopyIDsByTemplateID[contract.id]
        let isWorkspaceCopy = contract.isWorkspaceCopy
        let installLabel: String
        if isWorkspaceCopy {
            installLabel = "Workspace copy"
        } else if source == .saved {
            installLabel = "Saved"
        } else if workspaceCopyID != nil {
            installLabel = "Installed"
        } else {
            installLabel = "Install to Studio"
        }
        let integrationLabels = contract.orderedSkillBindings
            .filter { $0.kind == .extensionPackage }
            .map { LoopOpsPublicSkillPolicy.publicFacing($0.title) }
        let skillLabels = contract.orderedSkillBindings
            .filter { $0.kind == .skill }
            .prefix(2)
            .map { LoopOpsPublicSkillPolicy.publicFacing($0.title) }
        let inputLabels = contract.inputBindings.isEmpty
            ? ["Current workspace context"]
            : contract.inputBindings.map { LoopOpsPublicSkillPolicy.publicFacing($0) }
        let knowledgeLabels = inputLabels.filter { label in
            let lowercased = label.lowercased()
            return lowercased.contains("knowledge")
                || lowercased.contains("workspace")
                || lowercased.contains("attachment")
                || lowercased.contains("document")
                || lowercased.contains("context")
        }
        let resolvedKnowledge = knowledgeLabels.isEmpty ? ["Workspace knowledge when provided"] : knowledgeLabels
        let sourceLabel = isWorkspaceCopy ? "Workspace copy" : (source == .saved ? "Local Library" : "Loop Marketplace")
        let accessLabel: String
        if workspaceCopyID != nil || isWorkspaceCopy {
            accessLabel = "Installed"
        } else if source == .starter {
            accessLabel = "Free"
        } else {
            accessLabel = contract.visibility.capitalized
        }
        let readinessChecklist = contract.setupChecklistItems.map { LoopOpsPublicSkillPolicy.publicFacing($0) }
        let tags = [
            contract.domain.title,
            source.rawValue,
            accessLabel,
            contract.isRunnable ? "Ready" : "Needs setup"
        ] + skillLabels
        return LoopOpsTemplateListing(
            id: contract.id,
            contract: contract,
            source: source,
            creatorLabel: sourceLabel,
            installLabel: installLabel,
            readinessLabel: contract.readinessLabel,
            exampleTask: contract.prompt,
            requirementLabels: [
                contract.trigger,
                contract.feedbackGate,
                contract.reviewBoundary
            ].map { LoopOpsPublicSkillPolicy.publicFacing($0) }
                .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
            templateTypeLabel: isWorkspaceCopy ? "Editable Loop" : (source == .starter ? "Template" : "Loop Contract"),
            categoryLabel: contract.domain.title,
            accessLabel: accessLabel,
            updatedLabel: contract.updatedAt.formatted(date: .abbreviated, time: .omitted),
            integrationLabels: integrationLabels.isEmpty ? ["Local workspace"] : integrationLabels,
            requiredInputLabels: inputLabels,
            requiredKnowledgeLabels: resolvedKnowledge,
            tagLabels: Array(Set(tags)).sorted(),
            readinessChecklist: readinessChecklist.isEmpty ? ["Ready to run"] : readinessChecklist,
            stepPreview: contract.stepSummary.map { LoopOpsPublicSkillPolicy.publicFacing($0) },
            workspaceCopyID: workspaceCopyID
        )
    }
}

enum LoopOpsPublicSkillPolicy {
    private static let publicCategories: Set<String> = [
        "analysis",
        "crypto",
        "document",
        "documents",
        "evidence",
        "handoff",
        "intelligence",
        "local-tool",
        "market",
        "marketdata",
        "markets",
        "multimodal",
        "office",
        "research",
        "review",
        "task"
    ]

    private static let blockedCategories: Set<String> = [
        "artifact",
        "channel",
        "gate",
        "internal",
        "memory",
        "provider",
        "runtime",
        "transport"
    ]

    private static let blockedStatuses: Set<String> = [
        "hidden",
        "internal",
        "provider_only",
        "runtime_only"
    ]

    private static let blockedIdentityFragments = [
        "dry-run",
        "feishu",
        "gate",
        "lark",
        "live-trading",
        "provider",
        "raw-provider",
        "runtime",
        "terminal",
        "trading-zac",
        "wechat-cli"
    ]

    private static let blockedTitleFragments = [
        "dry-run",
        "feishu",
        "gate",
        "internal",
        "lark",
        "provider",
        "runtime",
        "trading-zac",
        "飞书"
    ]

    static func isVisible(package: LoopOpsSkillPackage) -> Bool {
        isVisible(
            id: package.id,
            title: package.title,
            category: package.category,
            status: package.status
        )
    }

    static func isVisible(
        id: String,
        title: String,
        category: String?,
        status: String
    ) -> Bool {
        let normalizedCategory = normalized(category ?? "")
        if !normalizedCategory.isEmpty, blockedCategories.contains(normalizedCategory) {
            return false
        }

        if !normalizedCategory.isEmpty, !publicCategories.contains(normalizedCategory) {
            return false
        }

        let normalizedStatus = normalized(status)
        if blockedStatuses.contains(normalizedStatus) {
            return false
        }

        let identity = normalized("\(id) \(category ?? "")")
        if blockedIdentityFragments.contains(where: identity.contains) {
            return false
        }

        let publicTitle = normalized(title)
        if blockedTitleFragments.contains(where: publicTitle.contains) {
            return false
        }

        return true
    }

    static func publicFacing(_ value: String) -> String {
        value
            .replacingOccurrences(of: "provider", with: "source", options: [.caseInsensitive])
            .replacingOccurrences(of: "runtime", with: "workspace", options: [.caseInsensitive])
            .replacingOccurrences(of: "gate", with: "review rule", options: [.caseInsensitive])
            .replacingOccurrences(of: "QA", with: "Review", options: [])
            .replacingOccurrences(of: "qa", with: "review", options: [])
    }

    private static func normalized(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .replacingOccurrences(of: " ", with: "-")
    }
}

extension LoopOpsSkillBinding {
    static func normalizeCurrentOrder(_ bindings: [LoopOpsSkillBinding]) -> [LoopOpsSkillBinding] {
        bindings.enumerated().map { index, binding in
            var copy = binding
            copy.order = index
            return copy
        }
    }

    static func ordered(_ bindings: [LoopOpsSkillBinding]) -> [LoopOpsSkillBinding] {
        bindings
            .sorted { lhs, rhs in
                if lhs.order == rhs.order {
                    return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
                }
                return lhs.order < rhs.order
            }
            .enumerated()
            .map { index, binding in
                var copy = binding
                copy.order = index
                return copy
            }
    }

    static func from(skillIDs: [String], extensionIDs: [String], source: String = "template") -> [LoopOpsSkillBinding] {
        let skillBindings = skillIDs.enumerated().map { index, skillID in
            LoopOpsSkillBinding(
                kind: .skill,
                id: skillID,
                title: LoopContractBridge.readableCapabilityLabel(skillID),
                order: index,
                required: false,
                source: source
            )
        }
        let extensionBindings = extensionIDs.enumerated().map { index, extensionID in
            LoopOpsSkillBinding(
                kind: .extensionPackage,
                id: extensionID,
                title: LoopContractBridge.readableCapabilityLabel(extensionID),
                order: skillBindings.count + index,
                required: false,
                source: source
            )
        }
        return ordered(skillBindings + extensionBindings)
    }
}

struct LoopContract: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var domain: WorkbenchDomain
    var goal: String
    var trigger: String
    var inputBindings: [String]
    var capabilityChain: [String]
    var skillBindings: [LoopOpsSkillBinding]
    var stepSummary: [String]
    var feedbackGate: String
    var exitCondition: String
    var reviewBoundary: String
    var outputShape: String
    var runMode: LoopContractRunMode
    var version: Int
    var owner: String
    var visibility: String
    var prompt: String
    var defaultSkillIDs: [String]
    var defaultExtensionIDs: [String]
    var knowledgeSourceIDs: [String]
    var skillStackID: String?
    var installedFromTemplateID: String?
    var workspaceCopyID: String?
    var createdAt: Date
    var updatedAt: Date

    init(
        id: String,
        name: String,
        domain: WorkbenchDomain,
        goal: String,
        trigger: String,
        inputBindings: [String],
        capabilityChain: [String],
        skillBindings: [LoopOpsSkillBinding] = [],
        stepSummary: [String],
        feedbackGate: String,
        exitCondition: String,
        reviewBoundary: String,
        outputShape: String,
        runMode: LoopContractRunMode,
        version: Int,
        owner: String,
        visibility: String,
        prompt: String,
        defaultSkillIDs: [String],
        defaultExtensionIDs: [String],
        knowledgeSourceIDs: [String] = [],
        skillStackID: String? = nil,
        createdAt: Date,
        updatedAt: Date,
        installedFromTemplateID: String? = nil,
        workspaceCopyID: String? = nil
    ) {
        self.id = id
        self.name = name
        self.domain = domain
        self.goal = goal
        self.trigger = trigger
        self.inputBindings = inputBindings
        self.capabilityChain = capabilityChain
        self.skillBindings = LoopOpsSkillBinding.ordered(skillBindings)
        self.stepSummary = stepSummary
        self.feedbackGate = feedbackGate
        self.exitCondition = exitCondition
        self.reviewBoundary = reviewBoundary
        self.outputShape = outputShape
        self.runMode = runMode
        self.version = version
        self.owner = owner
        self.visibility = visibility
        self.prompt = prompt
        self.defaultSkillIDs = defaultSkillIDs
        self.defaultExtensionIDs = defaultExtensionIDs
        self.knowledgeSourceIDs = knowledgeSourceIDs
        self.skillStackID = skillStackID
        self.installedFromTemplateID = installedFromTemplateID
        self.workspaceCopyID = workspaceCopyID
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case domain
        case goal
        case trigger
        case inputBindings
        case capabilityChain
        case skillBindings
        case stepSummary
        case feedbackGate
        case exitCondition
        case reviewBoundary
        case outputShape
        case runMode
        case version
        case owner
        case visibility
        case prompt
        case defaultSkillIDs
        case defaultExtensionIDs
        case knowledgeSourceIDs
        case skillStackID
        case installedFromTemplateID
        case workspaceCopyID
        case createdAt
        case updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaultSkillIDs = try container.decodeIfPresent([String].self, forKey: .defaultSkillIDs) ?? []
        let defaultExtensionIDs = try container.decodeIfPresent([String].self, forKey: .defaultExtensionIDs) ?? []
        let skillBindings = try container.decodeIfPresent([LoopOpsSkillBinding].self, forKey: .skillBindings)
            ?? LoopOpsSkillBinding.from(skillIDs: defaultSkillIDs, extensionIDs: defaultExtensionIDs, source: "legacy")
        self.init(
            id: try container.decode(String.self, forKey: .id),
            name: try container.decode(String.self, forKey: .name),
            domain: try container.decode(WorkbenchDomain.self, forKey: .domain),
            goal: try container.decode(String.self, forKey: .goal),
            trigger: try container.decode(String.self, forKey: .trigger),
            inputBindings: try container.decodeIfPresent([String].self, forKey: .inputBindings) ?? [],
            capabilityChain: try container.decodeIfPresent([String].self, forKey: .capabilityChain) ?? [],
            skillBindings: skillBindings,
            stepSummary: try container.decodeIfPresent([String].self, forKey: .stepSummary) ?? [],
            feedbackGate: try container.decode(String.self, forKey: .feedbackGate),
            exitCondition: try container.decode(String.self, forKey: .exitCondition),
            reviewBoundary: try container.decode(String.self, forKey: .reviewBoundary),
            outputShape: try container.decode(String.self, forKey: .outputShape),
            runMode: try container.decodeIfPresent(LoopContractRunMode.self, forKey: .runMode) ?? .manual,
            version: try container.decodeIfPresent(Int.self, forKey: .version) ?? 1,
            owner: try container.decodeIfPresent(String.self, forKey: .owner) ?? "local-user",
            visibility: try container.decodeIfPresent(String.self, forKey: .visibility) ?? "private",
            prompt: try container.decode(String.self, forKey: .prompt),
            defaultSkillIDs: defaultSkillIDs,
            defaultExtensionIDs: defaultExtensionIDs,
            knowledgeSourceIDs: try container.decodeIfPresent([String].self, forKey: .knowledgeSourceIDs) ?? [],
            skillStackID: try container.decodeIfPresent(String.self, forKey: .skillStackID),
            createdAt: try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date(),
            updatedAt: try container.decodeIfPresent(Date.self, forKey: .updatedAt) ?? Date(),
            installedFromTemplateID: try container.decodeIfPresent(String.self, forKey: .installedFromTemplateID),
            workspaceCopyID: try container.decodeIfPresent(String.self, forKey: .workspaceCopyID)
        )
    }

    static func from(template: WorkbenchLoopTemplate, now: Date = Date()) -> LoopContract {
        let skillBindings = LoopOpsSkillBinding.from(
            skillIDs: template.defaultSkillIDs,
            extensionIDs: template.defaultExtensionIDs,
            source: "template"
        )
        return LoopContract(
            id: template.id,
            name: template.title,
            domain: template.domain,
            goal: template.subtitle,
            trigger: template.trigger,
            inputBindings: ["Current workspace context", "User attachments when provided"],
            capabilityChain: LoopContractBridge.readableCapabilityLabels(
                skillIDs: template.defaultSkillIDs,
                extensionIDs: template.defaultExtensionIDs
            ),
            skillBindings: skillBindings,
            stepSummary: template.stepsSummary,
            feedbackGate: template.feedbackGate,
            exitCondition: template.exitCondition,
            reviewBoundary: template.reviewBoundary,
            outputShape: template.outputShape,
            runMode: .manual,
            version: 1,
            owner: "local-user",
            visibility: "private",
            prompt: template.prompt,
            defaultSkillIDs: template.defaultSkillIDs,
            defaultExtensionIDs: template.defaultExtensionIDs,
            createdAt: now,
            updatedAt: now
        )
    }

    static func from(strictLoopOpsContract contract: LoopOpsLoopContract) -> LoopContract {
        let createdAt = AgentDateFormatting.parse(contract.createdAt) ?? Date()
        let updatedAt = AgentDateFormatting.parse(contract.updatedAt) ?? createdAt
        let migration = contract.templateMigration
        let capabilityChain = contract.userFacingCapabilityChain.map { LoopContractBridge.readableCapabilityLabel($0.title) }
        let derivedRuntimeIDs = LoopContractBridge.runtimeIDs(from: contract.userFacingCapabilityChain)
        let defaultSkillIDs = migration?.legacySkillIDs ?? derivedRuntimeIDs.skillIDs
        let defaultExtensionIDs = migration?.legacyExtensionIDs ?? derivedRuntimeIDs.extensionIDs
        return LoopContract(
            id: contract.id,
            name: contract.name,
            domain: contract.domain.workbenchDomain,
            goal: contract.goal,
            trigger: contract.trigger,
            inputBindings: contract.inputBindings
                .filter { $0.kind != .prompt }
                .map(\.label),
            capabilityChain: capabilityChain.isEmpty
                ? LoopContractBridge.readableCapabilityLabels(
                    skillIDs: defaultSkillIDs,
                    extensionIDs: defaultExtensionIDs
                )
                : capabilityChain,
            skillBindings: LoopOpsSkillBinding.from(
                skillIDs: defaultSkillIDs,
                extensionIDs: defaultExtensionIDs,
                source: "strict-json"
            ),
            stepSummary: contract.stepSummary,
            feedbackGate: contract.feedbackGate,
            exitCondition: contract.exitCondition,
            reviewBoundary: contract.reviewBoundary,
            outputShape: contract.outputShape,
            runMode: LoopContractRunMode(scheduleMode: contract.scheduleMode),
            version: contract.version,
            owner: contract.owner,
            visibility: contract.visibility.rawValue,
            prompt: migration?.launchPrompt ?? contract.goal,
            defaultSkillIDs: defaultSkillIDs,
            defaultExtensionIDs: defaultExtensionIDs,
            knowledgeSourceIDs: contract.knowledgeSourceIDs,
            skillStackID: contract.skillStackID,
            createdAt: createdAt,
            updatedAt: updatedAt,
            installedFromTemplateID: migration?.sourceTemplateID == contract.id ? nil : migration?.sourceTemplateID,
            workspaceCopyID: nil
        )
    }

    func strictLoopOpsContract(status: LoopOpsContractStatus = .saved) -> LoopOpsLoopContract {
        LoopOpsLoopContract(
            id: id,
            name: name,
            domain: LoopOpsDomain(workbenchDomain: domain),
            goal: goal,
            trigger: trigger,
            inputBindings: LoopContractBridge.strictInputBindings(
                contractID: id,
                prompt: prompt,
                labels: inputBindings
            ),
            userFacingCapabilityChain: LoopContractBridge.strictCapabilityReferences(
                labels: capabilityChain,
                skillIDs: orderedSkillIDs,
                extensionIDs: orderedExtensionIDs
            ),
            stepSummary: stepSummary,
            feedbackGate: feedbackGate,
            exitCondition: exitCondition,
            reviewBoundary: reviewBoundary,
            outputShape: outputShape,
            scheduleMode: LoopOpsScheduleMode(runMode: runMode),
            version: version,
            owner: owner,
            visibility: LoopOpsVisibility(rawValue: visibility) ?? .private,
            status: status,
            knowledgeSourceIDs: knowledgeSourceIDs,
            skillStackID: skillStackID,
            createdAt: AgentDateFormatting.isoString(createdAt),
            updatedAt: AgentDateFormatting.isoString(updatedAt),
            templateMigration: LoopOpsTemplateMigrationSource(
                sourceTemplateID: installedFromTemplateID ?? id,
                sourceTemplateTitle: name,
                launchPrompt: prompt,
                legacySkillIDs: orderedSkillIDs,
                legacyExtensionIDs: orderedExtensionIDs
            )
        )
    }

    var readinessLabel: String {
        isRunnable ? "Ready" : "Needs setup"
    }

    var isWorkspaceCopy: Bool {
        installedFromTemplateID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    var setupChecklistItems: [String] {
        var items: [String] = []
        func requireText(_ value: String, _ message: String) {
            if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                items.append(message)
            }
        }

        requireText(name, "Add a Loop Contract name.")
        requireText(goal, "Describe the Loop goal.")
        requireText(trigger, "Define when this Loop should run.")
        if stepSummary.isEmpty {
            items.append("Add at least one visible step.")
        }
        requireText(feedbackGate, "Define the review rule before final output.")
        requireText(exitCondition, "Define the exit condition.")
        requireText(reviewBoundary, "State the review-only boundary.")
        requireText(outputShape, "Describe the output shape.")
        requireText(prompt, "Write the launch prompt.")
        if activeSkillBindings.isEmpty {
            items.append("Add at least one enabled skill or package to the Skill Path.")
        }
        return items
    }

    var setupChecklistSummary: String {
        let items = setupChecklistItems
        if items.isEmpty {
            return "All required contract fields are ready."
        }
        return items.enumerated()
            .map { index, item in "\(index + 1). \(item)" }
            .joined(separator: "\n")
    }

    var setupPrompt: String {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Untitled Loop" : name
        return """
        Finish setup for \(title):
        \(setupChecklistSummary)

        Update the visible Loop Contract in Studio, keep ordered Skill Path and review-only boundaries clear, then run again.
        """
    }

    var isRunnable: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !trigger.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !stepSummary.isEmpty
            && !feedbackGate.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !exitCondition.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !reviewBoundary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !outputShape.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !activeSkillBindings.isEmpty
    }

    func promptForRun(additionalInstruction: String? = nil, knowledgeScopeSummary: String? = nil) -> String {
        let extra = additionalInstruction?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let suffix = extra.isEmpty ? "" : "\n\n本轮追加指令：\(extra)"
        let skillPathText = orderedSkillPathLabels.isEmpty
            ? "未指定；此 Loop 需要在 Studio 中保存明确的 Skill Path。"
            : orderedSkillPathLabels.joined(separator: " -> ")
        let inputBindingText = inputBindings.isEmpty
            ? "未指定。"
            : inputBindings.joined(separator: " / ")
        let trimmedKnowledgeSummary = knowledgeScopeSummary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let knowledgeScopeText: String
        if !trimmedKnowledgeSummary.isEmpty {
            knowledgeScopeText = trimmedKnowledgeSummary
        } else if !knowledgeSourceIDs.isEmpty {
            knowledgeScopeText = knowledgeSourceIDs.joined(separator: " / ")
        } else {
            knowledgeScopeText = "未绑定；只使用本轮输入和已选运行上下文。"
        }
        return """
        运行 Loop：\(name)
        Domain：\(domain.title)
        Goal：\(goal)
        Trigger：\(trigger)
        Inputs：\(inputBindingText)
        Knowledge Scope：\(knowledgeScopeText)
        Skill Path：\(skillPathText)
        Steps：\(stepSummary.joined(separator: " / "))
        Review Rule：\(feedbackGate)
        Exit Condition：\(exitCondition)
        Review Boundary：\(reviewBoundary)
        Output Shape：\(outputShape)

        \(prompt)\(suffix)
        """
    }

    var orderedSkillBindings: [LoopOpsSkillBinding] {
        let bindings = LoopOpsSkillBinding.ordered(skillBindings)
        if !bindings.isEmpty {
            return bindings
        }
        return LoopOpsSkillBinding.from(skillIDs: defaultSkillIDs, extensionIDs: defaultExtensionIDs, source: "runtime-fallback")
    }

    var activeSkillBindings: [LoopOpsSkillBinding] {
        orderedSkillBindings.filter(\.enabled)
    }

    var orderedSkillIDs: [String] {
        if !skillBindings.isEmpty {
            return activeSkillBindings
                .filter { $0.kind == .skill }
                .map(\.id)
        }
        return defaultSkillIDs
    }

    var orderedExtensionIDs: [String] {
        if !skillBindings.isEmpty {
            return activeSkillBindings
                .filter { $0.kind == .extensionPackage }
                .map(\.id)
        }
        return defaultExtensionIDs
    }

    var orderedSkillPathLabels: [String] {
        activeSkillBindings.map(\.title)
    }

    func replacingSkillBindings(_ bindings: [LoopOpsSkillBinding], now: Date = Date()) -> LoopContract {
        let orderedBindings = LoopOpsSkillBinding.ordered(bindings)
        var copy = self
        copy.skillBindings = orderedBindings
        let activeBindings = orderedBindings.filter(\.enabled)
        copy.defaultSkillIDs = activeBindings.filter { $0.kind == .skill }.map(\.id)
        copy.defaultExtensionIDs = activeBindings.filter { $0.kind == .extensionPackage }.map(\.id)
        copy.capabilityChain = orderedBindings.map(\.title)
        copy.updatedAt = now
        return copy
    }
}

private extension LoopContractRunMode {
    init(scheduleMode: LoopOpsScheduleMode) {
        switch scheduleMode {
        case .manual:
            self = .manual
        case .scheduled:
            self = .scheduled
        }
    }
}

private extension LoopOpsScheduleMode {
    init(runMode: LoopContractRunMode) {
        switch runMode {
        case .manual:
            self = .manual
        case .scheduled:
            self = .scheduled
        }
    }
}

private enum LoopContractBridge {
    static func readableCapabilityLabel(_ value: String) -> String {
        capabilityDescriptor(for: value).title
    }

    static func readableCapabilityLabels(skillIDs: [String], extensionIDs: [String]) -> [String] {
        (extensionIDs + skillIDs).map { capabilityDescriptor(for: $0).title }
    }

    static func strictInputBindings(contractID: String, prompt: String, labels: [String]) -> [LoopOpsInputBinding] {
        let promptBinding = LoopOpsInputBinding(
            id: "\(contractID)-prompt",
            label: "Prompt",
            kind: .prompt,
            required: true,
            valueHint: prompt
        )
        let userBindings = labels.enumerated().map { index, label in
            LoopOpsInputBinding(
                id: "\(contractID)-input-\(index + 1)",
                label: label,
                kind: inputKind(for: label),
                required: false
            )
        }
        return [promptBinding] + userBindings
    }

    static func strictCapabilityReferences(
        labels: [String],
        skillIDs: [String],
        extensionIDs: [String]
    ) -> [LoopOpsCapabilityReference] {
        let sourceLabels = labels.isEmpty ? readableCapabilityLabels(skillIDs: skillIDs, extensionIDs: extensionIDs) : labels
        return sourceLabels.enumerated().map { index, label in
            let descriptor = capabilityDescriptor(for: label)
            return LoopOpsCapabilityReference(
                id: "capability-\(index + 1)",
                title: descriptor.title,
                summary: descriptor.summary,
                category: descriptor.category
            )
        }
    }

    static func runtimeIDs(
        from references: [LoopOpsCapabilityReference]
    ) -> (skillIDs: [String], extensionIDs: [String]) {
        var skillIDs: [String] = []
        var extensionIDs: [String] = []
        for reference in references {
            guard let runtimeID = runtimeID(forCapabilityTitle: reference.title) else { continue }
            switch runtimeID.kind {
            case .skill:
                if !skillIDs.contains(runtimeID.id) {
                    skillIDs.append(runtimeID.id)
                }
            case .extensionPackage:
                if !extensionIDs.contains(runtimeID.id) {
                    extensionIDs.append(runtimeID.id)
                }
            }
        }
        return (skillIDs, extensionIDs)
    }

    private static func inputKind(for label: String) -> LoopOpsInputKind {
        let normalized = label.lowercased()
        if normalized.contains("file") || normalized.contains("attachment") || normalized.contains("material") {
            return .file
        }
        if normalized.contains("symbol") || normalized.contains("ticker") {
            return .marketSymbol
        }
        if normalized.contains("context") {
            return .loopContext
        }
        return .freeform
    }

    private static func capabilityDescriptor(
        for value: String
    ) -> (title: String, summary: String, category: LoopOpsCapabilityCategory) {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        switch normalized {
        case "cmc-market-radar", "CoinMarketCap market radar":
            return ("CoinMarketCap market radar", "Market evidence and candidate scanning.", .marketData)
        case "market-regime-review", "Market regime review":
            return ("Market regime review", "Risk stance, missing inputs, and review conditions.", .review)
        case "social-price-divergence", "Social and price divergence review":
            return ("Social and price divergence review", "Checks discussion signals against price behavior.", .review)
        case "equity-company-deep-dive", "Company deep dive":
            return ("Company deep dive", "Business quality, thesis, and contradiction review.", .research)
        case "equity-thesis-tracker", "Equity thesis tracker":
            return ("Equity thesis tracker", "Tracks support, contradiction, and follow-up research.", .research)
        case "equity-earnings-review", "Earnings review":
            return ("Earnings review", "Revenue quality, margin, guidance, and management tone.", .review)
        case "macro-cross-asset-readthrough", "Cross-asset read-through":
            return ("Cross-asset read-through", "Connects macro, equity, and crypto risk signals.", .research)
        case "equity-sector-scan", "Sector scan":
            return ("Sector scan", "Finds sector-level research candidates and gaps.", .research)
        case "meeting-cloud-asr", "Cloud transcription":
            return ("Cloud transcription", "Turns meeting media into reviewable transcript material.", .transcription)
        case "meeting-minutes", "Meeting minutes":
            return ("Meeting minutes", "Creates structured notes, action items, and open questions.", .drafting)
        case "document-generation", "Document drafting":
            return ("Document drafting", "Turns source material into a readable draft.", .drafting)
        case "document-revision", "Document revision":
            return ("Document revision", "Refines wording, structure, and unresolved questions.", .drafting)
        case "feishu-agent-bridge", "Feishu delivery preview":
            return ("Feishu delivery preview", "Prepares a preview before any confirmed delivery.", .deliveryPreview)
        case "markets-research", "Markets research capability":
            return ("Markets research capability", "Research workflow support for markets loops.", .research)
        case "cmc-skill-hub", "CMC Skill Hub", "CMC Skill Hub capability":
            return ("CMC Skill Hub capability", "Read-only crypto market evidence capability.", .marketData)
        case "wechat-cli-export-bridge", "WeChat context bridge":
            return ("WeChat context bridge", "Local message context when explicitly selected.", .context)
        case "office-meeting-agent", "Office meeting agent":
            return ("Office meeting agent", "Meeting, document, and delivery preview support.", .drafting)
        default:
            return (readableTitle(from: normalized), "User-facing loop capability.", .research)
        }
    }

    private static func runtimeID(forCapabilityTitle title: String) -> (kind: LoopOpsSkillBindingKind, id: String)? {
        switch capabilityDescriptor(for: title).title {
        case "CMC Skill Hub capability":
            return (.extensionPackage, "cmc-skill-hub")
        case "WeChat context bridge":
            return (.extensionPackage, "wechat-cli-export-bridge")
        case "Office meeting agent":
            return (.extensionPackage, "office-meeting-agent")
        case "CoinMarketCap market radar":
            return (.skill, "cmc-market-radar")
        case "Market regime review":
            return (.skill, "market-regime-review")
        case "Social and price divergence review":
            return (.skill, "social-price-divergence")
        case "Company deep dive":
            return (.skill, "equity-company-deep-dive")
        case "Equity thesis tracker":
            return (.skill, "equity-thesis-tracker")
        case "Earnings review":
            return (.skill, "equity-earnings-review")
        case "Cross-asset read-through":
            return (.skill, "macro-cross-asset-readthrough")
        case "Sector scan":
            return (.skill, "equity-sector-scan")
        case "Cloud transcription":
            return (.skill, "meeting-cloud-asr")
        case "Meeting minutes":
            return (.skill, "meeting-minutes")
        case "Document drafting":
            return (.skill, "document-generation")
        case "Document revision":
            return (.skill, "document-revision")
        case "Feishu delivery preview":
            return (.skill, "feishu-agent-bridge")
        case "Markets research capability":
            return (.skill, "markets-research")
        default:
            return nil
        }
    }

    private static func readableTitle(from value: String) -> String {
        guard !value.contains(" ") else { return value }
        return value
            .replacingOccurrences(of: "_", with: "-")
            .split(separator: "-")
            .map { $0.uppercased() == "CMC" ? "CMC" : $0.capitalized }
            .joined(separator: " ")
    }
}

struct ChatMessage: Identifiable, Codable, Hashable {
    enum Role: String, Codable, Hashable {
        case user
        case assistant
        case system
    }

    var id: String
    var role: Role
    var text: String
    var createdAt: Date
    var attachments: [LoopOpsChatAttachment]
    var controlMetadata: LoopOpsChatControlMetadata?

    init(
        id: String = UUID().uuidString,
        role: Role,
        text: String,
        createdAt: Date = Date(),
        attachments: [LoopOpsChatAttachment] = [],
        controlMetadata: LoopOpsChatControlMetadata? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.attachments = attachments
        self.controlMetadata = controlMetadata
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case role
        case text
        case createdAt
        case attachments
        case controlMetadata
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        role = try container.decode(Role.self, forKey: .role)
        text = try container.decode(String.self, forKey: .text)
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date()
        attachments = try container.decodeIfPresent([LoopOpsChatAttachment].self, forKey: .attachments) ?? []
        controlMetadata = try container.decodeIfPresent(LoopOpsChatControlMetadata.self, forKey: .controlMetadata)
    }
}

enum LoopOpsChatSearchMode: String, Codable, Hashable, CaseIterable {
    case off
    case workspace
    case web

    var title: String {
        switch self {
        case .off: return "Off"
        case .workspace: return "Workspace"
        case .web: return "Web"
        }
    }

    var next: LoopOpsChatSearchMode {
        switch self {
        case .off: return .workspace
        case .workspace: return .web
        case .web: return .off
        }
    }
}

struct LoopOpsChatControlMetadata: Codable, Hashable {
    var model: String
    var mode: String
    var searchMode: LoopOpsChatSearchMode
    var temporary: Bool
    var promptCategory: String?
    var attachmentSummaries: [String]

    init(
        model: String,
        mode: String,
        searchMode: LoopOpsChatSearchMode,
        temporary: Bool,
        promptCategory: String? = nil,
        attachmentSummaries: [String] = []
    ) {
        self.model = model
        self.mode = mode
        self.searchMode = searchMode
        self.temporary = temporary
        self.promptCategory = promptCategory
        self.attachmentSummaries = attachmentSummaries
    }
}

struct ChatThread: Identifiable, Codable, Hashable {
    var id: String
    var scope: ChatScope
    var scopeID: String
    var title: String
    var generatedLoopDraftID: String?
    var followUpRunIDs: [String]
    var memoryCandidates: [String]
    var messages: [ChatMessage]
    var updatedAt: Date
}

struct ReviewPacketViewModel: Identifiable, Codable, Hashable {
    var id: String
    var runID: String
    var finalAnswer: String
    var domainSummary: String
    var claims: [String]
    var evidenceGaps: [String]
    var uncertainty: String
    var blockedActions: [String]
    var nextQuestions: [String]
    var reviewDecision: String
    var reviewNotes: String
    var eventHistory: [LoopOpsReviewPacketEvent]

    init(
        id: String,
        runID: String,
        finalAnswer: String,
        domainSummary: String,
        claims: [String],
        evidenceGaps: [String],
        uncertainty: String,
        blockedActions: [String],
        nextQuestions: [String],
        reviewDecision: String,
        reviewNotes: String = "",
        eventHistory: [LoopOpsReviewPacketEvent] = []
    ) {
        self.id = id
        self.runID = runID
        self.finalAnswer = finalAnswer
        self.domainSummary = domainSummary
        self.claims = claims
        self.evidenceGaps = evidenceGaps
        self.uncertainty = uncertainty
        self.blockedActions = blockedActions
        self.nextQuestions = nextQuestions
        self.reviewDecision = reviewDecision
        self.reviewNotes = reviewNotes
        self.eventHistory = eventHistory
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case runID
        case finalAnswer
        case domainSummary
        case claims
        case evidenceGaps
        case uncertainty
        case blockedActions
        case nextQuestions
        case reviewDecision
        case reviewNotes
        case eventHistory
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try container.decode(String.self, forKey: .id),
            runID: try container.decode(String.self, forKey: .runID),
            finalAnswer: try container.decode(String.self, forKey: .finalAnswer),
            domainSummary: try container.decode(String.self, forKey: .domainSummary),
            claims: try container.decodeIfPresent([String].self, forKey: .claims) ?? [],
            evidenceGaps: try container.decodeIfPresent([String].self, forKey: .evidenceGaps) ?? [],
            uncertainty: try container.decodeIfPresent(String.self, forKey: .uncertainty) ?? "",
            blockedActions: try container.decodeIfPresent([String].self, forKey: .blockedActions) ?? [],
            nextQuestions: try container.decodeIfPresent([String].self, forKey: .nextQuestions) ?? [],
            reviewDecision: try container.decodeIfPresent(String.self, forKey: .reviewDecision) ?? "pending",
            reviewNotes: try container.decodeIfPresent(String.self, forKey: .reviewNotes) ?? "",
            eventHistory: try container.decodeIfPresent([LoopOpsReviewPacketEvent].self, forKey: .eventHistory) ?? []
        )
    }

    func applyingReviewDecision(
        _ decision: String,
        notes: String? = nil,
        actor: String = "local-user",
        occurredAt: String = AgentDateFormatting.isoString(Date())
    ) -> ReviewPacketViewModel {
        let cleanNotes = notes?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextNotes = cleanNotes?.isEmpty == false ? cleanNotes! : reviewNotes
        let event = LoopOpsReviewPacketEvent(
            id: "review-event-\(runID)-\(decision.replacingOccurrences(of: " ", with: "-").lowercased())-\(eventHistory.count + 1)",
            kind: "decision",
            title: "Decision changed to \(decision)",
            detail: nextNotes.isEmpty ? "Review packet updated from the decision controls." : nextNotes,
            actor: actor,
            occurredAt: occurredAt
        )
        var copy = self
        copy.reviewDecision = decision
        copy.reviewNotes = nextNotes
        copy.eventHistory = Array((eventHistory + [event]).suffix(16))
        return copy
    }

    static func from(
        task: AgentLongTask,
        domain: WorkbenchDomain,
        finalReadModel: AgentFinalReadModel?
    ) -> ReviewPacketViewModel {
        let final = finalReadModel?.finalText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let safeFinal = final.isEmpty ? "尚未写入最终答案。" : AgentOutputCopy.humanize(final)
        let blocked: [String]
        switch domain {
        case .crypto:
            blocked = ["Live trading handoff", "External publish"]
        case .markets:
            blocked = ["BUY/HOLD/SELL execution", "External publish"]
        case .office:
            blocked = ["Feishu live publish without confirmation", "External send"]
        }
        let gaps = [
            finalReadModel?.cmcGateSummary?.emptyEvidenceReason,
            finalReadModel?.cmcGateSummary?.reason
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return ReviewPacketViewModel(
            id: task.runID,
            runID: task.runID,
            finalAnswer: safeFinal,
            domainSummary: "\(domain.title) review packet",
            claims: final.isEmpty ? [] : [String(safeFinal.prefix(140))],
            evidenceGaps: gaps,
            uncertainty: finalReadModel?.status ?? task.status,
            blockedActions: blocked,
            nextQuestions: ["需要补充哪些输入？", "是否要 fork 成下一轮 loop？"],
            reviewDecision: "pending",
            reviewNotes: "Created from the run result. Human review is required before external action.",
            eventHistory: [
                LoopOpsReviewPacketEvent(
                    id: "review-event-\(task.runID)-created",
                    kind: "created",
                    title: "Packet created",
                    detail: "\(gaps.count) evidence gap(s) captured.",
                    actor: "LoopOps",
                    occurredAt: AgentDateFormatting.isoString(Date())
                )
            ]
        )
    }
}

struct RunLedgerRow: Identifiable, Codable, Hashable {
    var id: String
    var loopContractID: String?
    var runID: String
    var title: String
    var domain: WorkbenchDomain
    var status: String
    var startedAt: String?
    var completedAt: String?
    var inputsUsed: [String]
    var finalAnswerPreview: String
    var evidenceGaps: [String]
    var blockedActions: [String]
    var reviewDecision: String
    var followUpPrompts: [String]
    var cloneable: Bool
    var replayable: Bool
    var skillPath: [String]?
    var lifecycleEvents: [String]?
    var knowledgeSourceIDs: [String]?

    init(
        id: String,
        loopContractID: String?,
        runID: String,
        title: String,
        domain: WorkbenchDomain,
        status: String,
        startedAt: String?,
        completedAt: String?,
        inputsUsed: [String],
        finalAnswerPreview: String,
        evidenceGaps: [String],
        blockedActions: [String],
        reviewDecision: String,
        followUpPrompts: [String],
        cloneable: Bool,
        replayable: Bool,
        skillPath: [String]? = nil,
        lifecycleEvents: [String]? = nil,
        knowledgeSourceIDs: [String]? = nil
    ) {
        self.id = id
        self.loopContractID = loopContractID
        self.runID = runID
        self.title = title
        self.domain = domain
        self.status = status
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.inputsUsed = inputsUsed
        self.finalAnswerPreview = finalAnswerPreview
        self.evidenceGaps = evidenceGaps
        self.blockedActions = blockedActions
        self.reviewDecision = reviewDecision
        self.followUpPrompts = followUpPrompts
        self.cloneable = cloneable
        self.replayable = replayable
        self.skillPath = skillPath
        self.lifecycleEvents = lifecycleEvents
        self.knowledgeSourceIDs = knowledgeSourceIDs
    }

    static func from(
        run: WorkbenchLoopRunState,
        finalReadModel: AgentFinalReadModel?
    ) -> RunLedgerRow {
        let packet = ReviewPacketViewModel.from(task: run.task, domain: run.domain, finalReadModel: finalReadModel)
        return RunLedgerRow(
            id: run.task.runID,
            loopContractID: run.capabilityLoop?.loopType,
            runID: run.task.runID,
            title: run.title,
            domain: run.domain,
            status: run.task.status,
            startedAt: nil,
            completedAt: run.task.updatedAt,
            inputsUsed: [run.domain.title, "Workspace context"],
            finalAnswerPreview: packet.finalAnswer,
            evidenceGaps: packet.evidenceGaps,
            blockedActions: packet.blockedActions,
            reviewDecision: packet.reviewDecision,
            followUpPrompts: run.capabilityLoop?.followUpSuggestions.map(\.prompt) ?? [],
            cloneable: true,
            replayable: true,
            skillPath: (run.task.selectedExtensionIDs ?? []) + (run.task.selectedSkillIDs ?? []),
            lifecycleEvents: ["Queued", "Running capability chain"],
            knowledgeSourceIDs: []
        )
    }

    static func from(
        task: AgentLongTask,
        contract: LoopContract,
        finalReadModel: AgentFinalReadModel? = nil,
        knowledgeSourceIDs: [String] = []
    ) -> RunLedgerRow {
        let packet = ReviewPacketViewModel.from(task: task, domain: contract.domain, finalReadModel: finalReadModel)
        return RunLedgerRow(
            id: task.runID,
            loopContractID: contract.id,
            runID: task.runID,
            title: contract.name,
            domain: contract.domain,
            status: task.status,
            startedAt: task.createdAt,
            completedAt: task.updatedAt,
            inputsUsed: contract.inputBindings.isEmpty ? [contract.domain.title, "Workspace context"] : contract.inputBindings,
            finalAnswerPreview: packet.finalAnswer,
            evidenceGaps: packet.evidenceGaps,
            blockedActions: packet.blockedActions,
            reviewDecision: packet.reviewDecision,
            followUpPrompts: packet.nextQuestions,
            cloneable: true,
            replayable: true,
            skillPath: contract.orderedSkillPathLabels,
            lifecycleEvents: ["Queued", "Submitted to run queue"],
            knowledgeSourceIDs: knowledgeSourceIDs
        )
    }

    func applyingReviewPacket(_ packet: ReviewPacketViewModel) -> RunLedgerRow {
        var copy = self
        copy.finalAnswerPreview = packet.finalAnswer
        copy.evidenceGaps = packet.evidenceGaps
        copy.blockedActions = packet.blockedActions
        copy.reviewDecision = packet.reviewDecision
        if !packet.nextQuestions.isEmpty {
            copy.followUpPrompts = packet.nextQuestions
        }
        if let event = packet.eventHistory.last {
            var events = copy.lifecycleEvents ?? []
            let ledgerLine = "Review packet · \(event.title) · \(event.occurredAt)"
            if !events.contains(ledgerLine) {
                events.append(ledgerLine)
            }
            copy.lifecycleEvents = Array(events.suffix(12))
        }
        return copy
    }

    func applyingLifecycleAction(_ action: LoopOpsRunLifecycleAction, occurredAt: String) -> RunLedgerRow {
        var copy = self
        copy.status = action.resultStatus
        if action.isTerminal {
            copy.completedAt = occurredAt
        } else if copy.startedAt == nil {
            copy.startedAt = occurredAt
        }
        var events = copy.lifecycleEvents ?? []
        events.append("\(action.title) · \(occurredAt)")
        copy.lifecycleEvents = Array(events.suffix(12))
        return copy
    }

    func attachingKnowledgeSource(id sourceID: String, title: String, occurredAt: String) -> RunLedgerRow {
        var copy = self
        var sourceIDs = copy.knowledgeSourceIDs ?? []
        if !sourceIDs.contains(sourceID) {
            sourceIDs.append(sourceID)
        }
        copy.knowledgeSourceIDs = sourceIDs
        var events = copy.lifecycleEvents ?? []
        events.append("Knowledge attached · \(title) · \(occurredAt)")
        copy.lifecycleEvents = Array(events.suffix(12))
        return copy
    }

    func detachingKnowledgeSource(id sourceID: String, title: String, occurredAt: String) -> RunLedgerRow {
        var copy = self
        var sourceIDs = copy.knowledgeSourceIDs ?? []
        sourceIDs.removeAll { $0 == sourceID }
        copy.knowledgeSourceIDs = sourceIDs
        var events = copy.lifecycleEvents ?? []
        events.append("Knowledge detached · \(title) · \(occurredAt)")
        copy.lifecycleEvents = Array(events.suffix(12))
        return copy
    }
}

enum LoopOpsRunResultReadiness: String, CaseIterable, Codable, Hashable {
    case waiting
    case ready
    case needsReview
    case blocked

    var title: String {
        switch self {
        case .waiting: return "Waiting"
        case .ready: return "Ready"
        case .needsReview: return "Needs review"
        case .blocked: return "Blocked"
        }
    }
}

struct LoopOpsRunResultAttempt: Identifiable, Codable, Hashable {
    var id: String
    var order: Int
    var title: String
    var detail: String
    var occurredAt: String?

    init(
        id: String,
        order: Int,
        title: String,
        detail: String,
        occurredAt: String? = nil
    ) {
        self.id = id
        self.order = order
        self.title = title
        self.detail = detail
        self.occurredAt = occurredAt
    }
}

struct LoopOpsRunResultState: Identifiable, Codable, Hashable {
    var id: String
    var runID: String
    var loopContractID: String?
    var title: String
    var domain: WorkbenchDomain
    var status: String
    var readiness: LoopOpsRunResultReadiness
    var finalAnswer: String
    var finalAnswerStatus: String
    var attempts: [LoopOpsRunResultAttempt]
    var evidenceGaps: [String]
    var blockedActions: [String]
    var reviewPacketID: String?
    var reviewDecision: String
    var shareSafeLogID: String?
    var runChatThreadID: String?
    var runChatMessageCount: Int
    var toolLogIDs: [String]
    var knowledgeSourceIDs: [String]
    var skillPath: [String]
    var inputSummary: [String]
    var canClone: Bool
    var canReplay: Bool

    static func from(
        ledger: RunLedgerRow,
        reviewPacket: ReviewPacketViewModel?,
        shareSafeLog: ShareSafeLogPreview?,
        runChatThread: ChatThread?,
        toolLogs: [LoopOpsToolLog],
        knowledgeSources: [LoopOpsKnowledgeSource]
    ) -> LoopOpsRunResultState {
        let finalPayload = resolvedFinalAnswer(ledger: ledger, reviewPacket: reviewPacket)
        let evidenceGaps = reviewPacket?.evidenceGaps ?? ledger.evidenceGaps
        let blockedActions = reviewPacket?.blockedActions ?? ledger.blockedActions
        let reviewDecision = reviewPacket?.reviewDecision ?? ledger.reviewDecision
        let readiness = resolvedReadiness(
            status: ledger.status,
            finalAnswer: finalPayload.text,
            evidenceGaps: evidenceGaps,
            blockedActions: blockedActions,
            reviewDecision: reviewDecision
        )
        return LoopOpsRunResultState(
            id: ledger.runID,
            runID: ledger.runID,
            loopContractID: ledger.loopContractID,
            title: ledger.title,
            domain: ledger.domain,
            status: ledger.status,
            readiness: readiness,
            finalAnswer: finalPayload.text,
            finalAnswerStatus: finalPayload.status,
            attempts: attempts(from: ledger),
            evidenceGaps: evidenceGaps,
            blockedActions: blockedActions,
            reviewPacketID: reviewPacket?.id,
            reviewDecision: reviewDecision,
            shareSafeLogID: shareSafeLog?.id,
            runChatThreadID: runChatThread?.id,
            runChatMessageCount: runChatThread?.messages.count ?? 0,
            toolLogIDs: toolLogs.map(\.id),
            knowledgeSourceIDs: uniqueStrings((ledger.knowledgeSourceIDs ?? []) + knowledgeSources.map(\.id)),
            skillPath: ledger.skillPath ?? [],
            inputSummary: ledger.inputsUsed,
            canClone: ledger.cloneable,
            canReplay: ledger.replayable
        )
    }

    private static func resolvedFinalAnswer(
        ledger: RunLedgerRow,
        reviewPacket: ReviewPacketViewModel?
    ) -> (text: String, status: String) {
        if let packetAnswer = reviewPacket?.finalAnswer.trimmingCharacters(in: .whitespacesAndNewlines),
           !isPendingAnswer(packetAnswer) {
            return (AgentOutputCopy.humanize(packetAnswer), "Review Packet")
        }
        let ledgerAnswer = ledger.finalAnswerPreview.trimmingCharacters(in: .whitespacesAndNewlines)
        if !isPendingAnswer(ledgerAnswer) {
            return (AgentOutputCopy.humanize(ledgerAnswer), "Saved")
        }
        return ("尚未写入最终答案。", "Waiting")
    }

    private static func resolvedReadiness(
        status: String,
        finalAnswer: String,
        evidenceGaps: [String],
        blockedActions: [String],
        reviewDecision: String
    ) -> LoopOpsRunResultReadiness {
        let normalizedStatus = status.lowercased()
        let normalizedDecision = reviewDecision.lowercased()
        let hasHardBlockedAction = blockedActions.map { $0.lowercased() }.contains { action in
            action.contains("failed")
                || action.contains("error")
                || action.contains("stopped")
                || action.contains("blocked run")
        }
        if normalizedStatus.contains("block")
            || normalizedStatus.contains("fail")
            || normalizedStatus.contains("error")
            || normalizedStatus.contains("cancel")
            || normalizedDecision.contains("blocked")
            || hasHardBlockedAction {
            return .blocked
        }
        if isPendingAnswer(finalAnswer)
            || normalizedStatus.contains("queue")
            || normalizedStatus.contains("running")
            || normalizedStatus.contains("wait")
            || normalizedStatus.contains("submit") {
            return .waiting
        }
        if normalizedDecision.contains("approved")
            || normalizedDecision.contains("reviewed")
            || normalizedDecision.contains("complete") {
            return .ready
        }
        if !evidenceGaps.isEmpty
            || normalizedDecision.contains("pending")
            || normalizedDecision.contains("needs")
            || normalizedDecision.contains("follow")
            || normalizedStatus.contains("review") {
            return .needsReview
        }
        return .ready
    }

    private static func attempts(from ledger: RunLedgerRow) -> [LoopOpsRunResultAttempt] {
        let events = ledger.lifecycleEvents?.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? []
        let attempts = events.enumerated().map { index, event in
            let parts = event.components(separatedBy: " · ")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            let title = parts.first ?? "Run event"
            let occurredAt = parts.count > 1 ? parts.last : nil
            let middle = parts.count > 2 ? Array(parts.dropFirst().dropLast()).joined(separator: " · ") : nil
            let detail = middle?.isEmpty == false ? middle! : event
            return LoopOpsRunResultAttempt(
                id: "\(ledger.runID)-attempt-\(index + 1)",
                order: index,
                title: title,
                detail: detail,
                occurredAt: occurredAt
            )
        }
        if !attempts.isEmpty {
            return attempts
        }
        var fallback: [LoopOpsRunResultAttempt] = []
        if let startedAt = ledger.startedAt {
            fallback.append(LoopOpsRunResultAttempt(
                id: "\(ledger.runID)-attempt-started",
                order: 0,
                title: "Started",
                detail: ledger.status,
                occurredAt: startedAt
            ))
        }
        if let completedAt = ledger.completedAt {
            fallback.append(LoopOpsRunResultAttempt(
                id: "\(ledger.runID)-attempt-completed",
                order: fallback.count,
                title: "Completed",
                detail: ledger.reviewDecision,
                occurredAt: completedAt
            ))
        }
        if fallback.isEmpty {
            fallback.append(LoopOpsRunResultAttempt(
                id: "\(ledger.runID)-attempt-created",
                order: 0,
                title: "Created",
                detail: ledger.status
            ))
        }
        return fallback
    }

    private static func isPendingAnswer(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.isEmpty
            || normalized == "尚未写入最终答案。"
            || normalized.contains("尚未写入")
            || normalized.contains("not yet")
            || normalized.contains("waiting")
    }

    private static func uniqueStrings(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { value in
            guard !seen.contains(value) else { return false }
            seen.insert(value)
            return true
        }
    }
}

struct ShareSafeLogPreview: Identifiable, Codable, Hashable {
    var id: String
    var title: String
    var redactedLoopSummary: String
    var redactedTimeline: [String]
    var finalAnswerExcerpt: String
    var reviewNotes: [String]
    var cloneInstructions: String
    var omittedSensitiveFieldsSummary: String

    static func from(ledger: RunLedgerRow) -> ShareSafeLogPreview {
        let safeExcerpt = redactedExcerpt(ledger.finalAnswerPreview)
        return ShareSafeLogPreview(
            id: ledger.runID,
            title: ledger.title,
            redactedLoopSummary: "\(ledger.domain.title) loop · \(ledger.status)",
            redactedTimeline: ledger.lifecycleEvents?.isEmpty == false
                ? ledger.lifecycleEvents!
                : ["Queued", "Ran capability chain", "Wrote final answer", "Awaited review"],
            finalAnswerExcerpt: String(safeExcerpt.prefix(280)),
            reviewNotes: ledger.evidenceGaps.isEmpty ? ["No visible evidence gap recorded."] : ledger.evidenceGaps,
            cloneInstructions: "Clone this log into a private loop, then rebind local inputs before running.",
            omittedSensitiveFieldsSummary: "Raw payloads, local setup metadata, secrets, local paths, and private source content omitted."
        )
    }

    private static func redactedExcerpt(_ text: String) -> String {
        var output = text
        let replacements: [(String, String)] = [
            (#"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, "[email omitted]"),
            (#"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*[^,\s]+"#, "[credential omitted]"),
            (#"(/Users|/private|/var|/tmp)/[^\s,;)]+"#, "[local path omitted]"),
            (#"[A-Fa-f0-9]{32,}"#, "[hash omitted]")
        ]
        for (pattern, replacement) in replacements {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
                continue
            }
            let range = NSRange(output.startIndex..<output.endIndex, in: output)
            output = regex.stringByReplacingMatches(in: output, options: [], range: range, withTemplate: replacement)
        }
        return output
    }
}

enum LoopOpsRunLifecycleAction: String, CaseIterable, Identifiable, Codable, Hashable {
    case start
    case pause
    case resume
    case complete
    case fail
    case cancel
    case retry

    var id: String { rawValue }

    var title: String {
        switch self {
        case .start: return "Start"
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .complete: return "Complete"
        case .fail: return "Fail"
        case .cancel: return "Cancel"
        case .retry: return "Retry"
        }
    }

    var resultStatus: String {
        switch self {
        case .start, .resume, .retry: return "running"
        case .pause: return "paused"
        case .complete: return "completed"
        case .fail: return "failed"
        case .cancel: return "cancelled"
        }
    }

    var systemImage: String {
        switch self {
        case .start: return "play.fill"
        case .pause: return "pause.fill"
        case .resume: return "play.circle"
        case .complete: return "checkmark"
        case .fail: return "xmark.octagon"
        case .cancel: return "stop.fill"
        case .retry: return "arrow.clockwise"
        }
    }

    var backendControlAction: String? {
        switch self {
        case .pause: return "pause"
        case .resume: return "resume"
        case .cancel: return "cancel"
        default: return nil
        }
    }

    var isTerminal: Bool {
        switch self {
        case .complete, .fail, .cancel:
            return true
        case .start, .pause, .resume, .retry:
            return false
        }
    }

    static func visibleActions(for status: String) -> [LoopOpsRunLifecycleAction] {
        let normalized = status.lowercased()
        if normalized.contains("pause") {
            return [.resume, .cancel, .retry]
        }
        if normalized.contains("complete") || normalized.contains("done") || normalized.contains("success") {
            return [.retry]
        }
        if normalized.contains("fail") || normalized.contains("cancel") {
            return [.retry]
        }
        if normalized.contains("queued") || normalized.contains("pending") || normalized.contains("waiting") {
            return [.start, .cancel]
        }
        return [.pause, .complete, .fail, .cancel]
    }
}

enum LoopOpsKnowledgeSourceKind: String, CaseIterable, Identifiable, Codable, Hashable {
    case blank
    case upload
    case website
    case integration
    case run
    case review
    case chat
    case log

    var id: String { rawValue }

    var title: String {
        switch self {
        case .blank: return "Blank"
        case .upload: return "Upload"
        case .website: return "Website"
        case .integration: return "Integration"
        case .run: return "Run"
        case .review: return "Review Packet"
        case .chat: return "Scoped Chat"
        case .log: return "Tool Log"
        }
    }

    var systemImage: String {
        switch self {
        case .blank: return "doc"
        case .upload: return "arrow.up.doc"
        case .website: return "link"
        case .integration: return "square.grid.2x2"
        case .run: return "arrow.triangle.2.circlepath"
        case .review: return "checkmark.seal"
        case .chat: return "bubble.left.and.text.bubble.right"
        case .log: return "clock.arrow.circlepath"
        }
    }
}

enum LoopOpsKnowledgeSourceStatus: String, CaseIterable, Identifiable, Codable, Hashable {
    case draft
    case ready
    case needsReview
    case syncing
    case stale
    case failed

    var id: String { rawValue }

    var title: String {
        switch self {
        case .draft: return "Draft"
        case .ready: return "Ready"
        case .needsReview: return "Needs review"
        case .syncing: return "Syncing"
        case .stale: return "Stale"
        case .failed: return "Failed"
        }
    }
}

enum LoopOpsKnowledgeReuseMode: String, CaseIterable, Identifiable, Codable, Hashable {
    case manual
    case attachToLoop
    case referenceOnly

    var id: String { rawValue }

    var title: String {
        switch self {
        case .manual: return "Manual"
        case .attachToLoop: return "Attach to loop"
        case .referenceOnly: return "Reference only"
        }
    }
}

struct LoopOpsKnowledgeSource: Identifiable, Codable, Hashable {
    var id: String
    var title: String
    var kind: LoopOpsKnowledgeSourceKind
    var summary: String
    var status: LoopOpsKnowledgeSourceStatus
    var reuseMode: LoopOpsKnowledgeReuseMode
    var linkedRunID: String?
    var linkedRunIDs: [String]?
    var activity: [String]?
    var sourceLabel: String
    var bodyMarkdown: String?
    var tags: [String]?
    var sourceURL: String?
    var documentCount: Int?
    var importProgress: Double?
    var errorSummary: String?
    var retryCount: Int?
    var lastSyncedAt: Date?
    var relatedReviewPacketIDs: [String]?
    var relatedChatThreadIDs: [String]?
    var relatedToolLogIDs: [String]?
    var createdAt: Date
    var updatedAt: Date

    init(
        id: String = "knowledge-\(UUID().uuidString)",
        title: String,
        kind: LoopOpsKnowledgeSourceKind,
        summary: String,
        status: LoopOpsKnowledgeSourceStatus = .draft,
        reuseMode: LoopOpsKnowledgeReuseMode = .manual,
        linkedRunID: String? = nil,
        linkedRunIDs: [String]? = nil,
        activity: [String]? = nil,
        sourceLabel: String,
        bodyMarkdown: String? = nil,
        tags: [String]? = nil,
        sourceURL: String? = nil,
        documentCount: Int? = nil,
        importProgress: Double? = nil,
        errorSummary: String? = nil,
        retryCount: Int? = nil,
        lastSyncedAt: Date? = nil,
        relatedReviewPacketIDs: [String]? = nil,
        relatedChatThreadIDs: [String]? = nil,
        relatedToolLogIDs: [String]? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.kind = kind
        self.summary = summary
        self.status = status
        self.reuseMode = reuseMode
        self.linkedRunID = linkedRunID
        self.linkedRunIDs = linkedRunIDs
        self.activity = activity
        self.sourceLabel = sourceLabel
        self.bodyMarkdown = bodyMarkdown
        self.tags = tags
        self.sourceURL = sourceURL
        self.documentCount = documentCount
        self.importProgress = importProgress
        self.errorSummary = errorSummary
        self.retryCount = retryCount
        self.lastSyncedAt = lastSyncedAt
        self.relatedReviewPacketIDs = relatedReviewPacketIDs
        self.relatedChatThreadIDs = relatedChatThreadIDs
        self.relatedToolLogIDs = relatedToolLogIDs
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    func isLinked(toRunID runID: String) -> Bool {
        linkedRunID == runID || (linkedRunIDs ?? []).contains(runID)
    }

    var canAttachToRun: Bool {
        status == .ready
    }

    var visibleDocumentCount: Int {
        if let documentCount {
            return max(0, documentCount)
        }
        return bodyMarkdown?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? 1 : 0
    }

    var normalizedImportProgress: Double {
        guard let importProgress else {
            return status == .ready ? 1 : 0
        }
        return min(max(importProgress, 0), 1)
    }

    var canRetrySetup: Bool {
        switch status {
        case .failed, .stale, .needsReview:
            return true
        case .draft, .ready, .syncing:
            return false
        }
    }

    var lifecycleSummary: String {
        let progress = Int((normalizedImportProgress * 100).rounded())
        switch status {
        case .draft:
            return "Draft setup · \(visibleDocumentCount) docs"
        case .needsReview:
            return "Needs review · \(progress)% prepared"
        case .syncing:
            return "Syncing · \(progress)%"
        case .ready:
            return "Ready · \(visibleDocumentCount) docs"
        case .stale:
            return "Stale · retry recommended"
        case .failed:
            return "Failed · \(errorSummary ?? "Needs attention")"
        }
    }

    func runtimeContextReference(runID: String? = nil) -> RuntimeObjectReference {
        let body = bodyMarkdown?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let valueParts = [
            summary.trimmingCharacters(in: .whitespacesAndNewlines),
            body
        ].filter { !$0.isEmpty }
        let value = valueParts.joined(separator: "\n\n").truncatedLoopOpsKnowledgeContext
        return RuntimeObjectReference(
            id: id,
            kind: .source,
            label: title,
            path: sourceURL?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? sourceURL : nil,
            value: value.isEmpty ? nil : value,
            source: sourceLabel,
            freshness: status == .stale ? .stale : (status == .ready ? .fresh : .unknown),
            confidence: nil,
            privacyLevel: "local",
            redactionStatus: "summary_only",
            generatedAt: AgentDateFormatting.isoString(updatedAt),
            runID: runID ?? linkedRunID
        )
    }
}

struct LoopOpsToolDraft: Identifiable, Codable, Hashable {
    var id: String
    var name: String
    var purpose: String
    var enabled: Bool?
    var integrationSource: String?
    var inputScope: String?
    var inputs: [String]
    var visibleSteps: [String]
    var outputShape: String
    var reviewPolicy: String
    var skillBindings: [LoopOpsSkillBinding]
    var createdAt: Date
    var updatedAt: Date

    init(
        id: String = "tool-draft-\(UUID().uuidString)",
        name: String,
        purpose: String,
        enabled: Bool = false,
        integrationSource: String? = nil,
        inputScope: String? = nil,
        inputs: [String],
        visibleSteps: [String],
        outputShape: String,
        reviewPolicy: String,
        skillBindings: [LoopOpsSkillBinding] = [],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.purpose = purpose
        self.enabled = enabled
        self.integrationSource = integrationSource
        self.inputScope = inputScope
        self.inputs = inputs
        self.visibleSteps = visibleSteps
        self.outputShape = outputShape
        self.reviewPolicy = reviewPolicy
        self.skillBindings = LoopOpsSkillBinding.ordered(skillBindings)
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    var resolvedIntegrationSource: String {
        integrationSource?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? integrationSource!
            : "Local Tool"
    }

    var resolvedInputScope: String {
        inputScope?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? inputScope!
            : (inputs.first ?? "Manual input")
    }

    var isEnabled: Bool {
        enabled ?? false
    }

    var requiredInputs: [String] {
        inputs
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    func missingInputNames(from values: [String: String]) -> [String] {
        requiredInputs.filter { name in
            values[name]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
        }
    }

    func inputSummary(from values: [String: String]) -> String {
        let parts = requiredInputs.compactMap { name -> String? in
            let value = values[name]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !value.isEmpty else { return nil }
            return "\(name): \(value.truncatedLoopOpsSummary)"
        }
        return parts.isEmpty ? "No inputs provided." : parts.joined(separator: "\n")
    }

    var outputSummary: String {
        let trimmed = outputShape.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Expected output not set." : trimmed
    }

    func loopContractForRun(inputValues: [String: String], linkedRunID: String? = nil, now: Date = Date()) -> LoopContract {
        let orderedBindings = LoopOpsSkillBinding.ordered(
            skillBindings.isEmpty
                ? [
                    LoopOpsSkillBinding(
                        kind: .skill,
                        id: id,
                        title: name,
                        order: 0,
                        required: true,
                        source: "skill-os-tool"
                    )
                ]
                : skillBindings
        )
        let inputSummary = inputSummary(from: inputValues)
        let prompt = """
        Run this Skill OS tool as a review-only LoopOps background task.

        Tool: \(name)
        Purpose: \(purpose)
        Input context: \(resolvedInputScope)
        Provided inputs:
        \(inputSummary)

        Keep external actions blocked unless the user explicitly confirms them.
        """
        let trigger = linkedRunID == nil
            ? "Manual run from Skill OS"
            : "Manual run from Skill OS linked to \(linkedRunID!)"
        return LoopContract(
            id: "skill-os-run-\(id)-\(UUID().uuidString)",
            name: name,
            domain: .office,
            goal: purpose,
            trigger: trigger,
            inputBindings: requiredInputs.isEmpty ? [resolvedInputScope] : requiredInputs,
            capabilityChain: orderedBindings.map(\.title),
            skillBindings: orderedBindings,
            stepSummary: visibleSteps.isEmpty ? ["Review inputs", "Run ordered skill path", "Return review-ready output"] : visibleSteps,
            feedbackGate: reviewPolicy,
            exitCondition: "Return \(outputSummary) and stop before any external action.",
            reviewBoundary: "Review-only; do not publish, trade, send, or mutate external systems without explicit confirmation.",
            outputShape: outputSummary,
            runMode: .manual,
            version: 1,
            owner: "Skill OS",
            visibility: "private",
            prompt: prompt,
            defaultSkillIDs: orderedBindings.filter { $0.kind == .skill }.map(\.id),
            defaultExtensionIDs: orderedBindings.filter { $0.kind == .extensionPackage }.map(\.id),
            createdAt: now,
            updatedAt: now
        )
    }
}

struct LoopOpsToolLog: Identifiable, Codable, Hashable {
    enum CanonicalStatus: String, Codable, Hashable, CaseIterable {
        case draft
        case validated
        case submitting
        case waiting
        case running
        case succeeded
        case failed
        case blocked

        var title: String {
            switch self {
            case .draft: return "Draft"
            case .validated: return "Validated"
            case .submitting: return "Submitting"
            case .waiting: return "Waiting"
            case .running: return "Run scoped"
            case .succeeded: return "Succeeded"
            case .failed: return "Failed"
            case .blocked: return "Blocked"
            }
        }
    }

    var id: String
    var toolID: String
    var title: String
    var status: String
    var summary: String
    var inputSummary: String?
    var outputSummary: String?
    var errorSummary: String?
    var durationLabel: String
    var reviewState: String
    var runID: String?
    var source: String?
    var userLabel: String?
    var costLabel: String?
    var createdAt: Date

    init(
        id: String = "tool-log-\(UUID().uuidString)",
        toolID: String,
        title: String,
        status: String,
        summary: String,
        inputSummary: String? = nil,
        outputSummary: String? = nil,
        errorSummary: String? = nil,
        durationLabel: String,
        reviewState: String,
        runID: String? = nil,
        source: String? = nil,
        userLabel: String? = nil,
        costLabel: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.toolID = toolID
        self.title = title
        self.status = status
        self.summary = summary
        self.inputSummary = inputSummary
        self.outputSummary = outputSummary
        self.errorSummary = errorSummary
        self.durationLabel = durationLabel
        self.reviewState = reviewState
        self.runID = runID
        self.source = source
        self.userLabel = userLabel
        self.costLabel = costLabel
        self.createdAt = createdAt
    }

    var resolvedUserLabel: String {
        userLabel?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? userLabel!
            : "Workspace"
    }

    var resolvedCostLabel: String {
        costLabel?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? costLabel!
            : "0 credits"
    }

    var resolvedInputSummary: String {
        inputSummary?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? inputSummary!
            : "No input summary recorded."
    }

    var resolvedOutputOrErrorSummary: String {
        if errorSummary?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return errorSummary!
        }
        if outputSummary?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return outputSummary!
        }
        return summary
    }

    var publicTitle: String {
        LoopOpsPublicSkillPolicy.publicFacing(title)
    }

    var publicSummary: String {
        LoopOpsPublicSkillPolicy.publicFacing(summary)
    }

    var publicReviewState: String {
        LoopOpsPublicSkillPolicy.publicFacing(reviewState)
    }

    var publicSourceLabel: String {
        LoopOpsPublicSkillPolicy.publicFacing(source ?? "Skill OS")
    }

    var publicInputSummary: String {
        LoopOpsPublicSkillPolicy.publicFacing(resolvedInputSummary)
    }

    var publicOutputOrErrorSummary: String {
        LoopOpsPublicSkillPolicy.publicFacing(resolvedOutputOrErrorSummary)
    }

    var canonicalStatus: CanonicalStatus {
        Self.canonicalStatus(from: status, reviewState: reviewState, output: resolvedOutputOrErrorSummary)
    }

    var publicStatusLabel: String {
        canonicalStatus.title
    }

    var reviewChatScopeID: String {
        "tool-log-\(id)"
    }

    static func canonicalStatus(from status: String, reviewState: String = "", output: String = "") -> CanonicalStatus {
        let haystack = "\(status) \(reviewState) \(output)".lowercased()
        if haystack.contains("fail") || haystack.contains("error") || haystack.contains("missing") {
            return .failed
        }
        if haystack.contains("block") || haystack.contains("stopped") || haystack.contains("cancel") {
            return .blocked
        }
        if haystack.contains("success") || haystack.contains("succeed") || haystack.contains("complete") || haystack.contains("saved") {
            return .succeeded
        }
        if haystack.contains("run scoped") || haystack.contains("running") || haystack.contains("background run") {
            return .running
        }
        if haystack.contains("submit") || haystack.contains("queue") {
            return .submitting
        }
        if haystack.contains("wait") || haystack.contains("pending") {
            return .waiting
        }
        if haystack.contains("valid") {
            return .validated
        }
        return .draft
    }
}

private extension String {
    var truncatedLoopOpsSummary: String {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 96 else { return trimmed }
        let index = trimmed.index(trimmed.startIndex, offsetBy: 96)
        return "\(trimmed[..<index])..."
    }

    var truncatedLoopOpsKnowledgeContext: String {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 6000 else { return trimmed }
        let index = trimmed.index(trimmed.startIndex, offsetBy: 6000)
        return "\(trimmed[..<index])..."
    }
}

struct LoopOpsToast: Identifiable, Hashable {
    enum Tone: String, Hashable {
        case info
        case success
        case warning
        case error
    }

    enum ActionKind: Hashable {
        case undoKnowledgeDetach(sourceID: String, runID: String)
    }

    struct Action: Hashable {
        var title: String
        var kind: ActionKind
    }

    var id: String
    var title: String
    var detail: String
    var tone: Tone
    var action: Action?
    var createdAt: Date

    init(
        id: String = "toast-\(UUID().uuidString)",
        title: String,
        detail: String,
        tone: Tone = .info,
        action: Action? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.tone = tone
        self.action = action
        self.createdAt = createdAt
    }
}

enum LoopOpsQuickActionKind: String, Codable, Hashable {
    case fillPrompt
    case runNow
    case createDraft
    case forkRun
    case markReviewed
    case attachMedia
}

struct LoopOpsQuickAction: Identifiable, Hashable {
    var id: String
    var title: String
    var systemImage: String
    var prompt: String
    var kind: LoopOpsQuickActionKind
}

struct LoopOpsBuilderDraftPatch: Codable, Hashable {
    enum StepMode: String, Codable, Hashable {
        case replace
        case append
    }

    enum SkillPathMode: String, Codable, Hashable {
        case append
        case replace
    }

    var steps: [String]
    var stepMode: StepMode
    var skillPathMode: SkillPathMode
    var name: String?
    var goal: String?
    var trigger: String?
    var inputBindings: [String]
    var feedbackGate: String?
    var exitCondition: String?
    var reviewBoundary: String?
    var outputShape: String?
    var skillBindings: [LoopOpsSkillBinding]
    var removedSkillBindings: [LoopOpsSkillBinding]
    var disabledSkillBindings: [LoopOpsSkillBinding]
    var enabledSkillBindings: [LoopOpsSkillBinding]
    var knowledgeSourceIDs: [String]

    init(
        instruction: String,
        packages: [LoopOpsSkillPackage],
        knowledgeSources: [LoopOpsKnowledgeSource] = []
    ) {
        let normalizedInstruction = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        let segments = Self.fieldSegments(in: normalizedInstruction)
        var parsedSteps: [String] = []
        var parsedStepMode: StepMode = .append
        var parsedName: String?
        var parsedGoal: String?
        var parsedTrigger: String?
        var parsedInputBindings: [String] = []
        var parsedFeedbackGate: String?
        var parsedExitCondition: String?
        var parsedReviewBoundary: String?
        var parsedOutputShape: String?
        var skillPathInstructions: [String] = []

        for segment in segments {
            switch segment.field {
            case .name:
                parsedName = segment.value
            case .goal:
                parsedGoal = segment.value
            case .trigger:
                parsedTrigger = segment.value
            case .inputBindings:
                parsedInputBindings.append(contentsOf: Self.stepItems(from: segment.value))
            case .steps:
                let values = Self.stepItems(from: segment.value)
                if !values.isEmpty {
                    parsedSteps.append(contentsOf: values)
                    parsedStepMode = segment.stepMode
                }
            case .feedbackGate:
                parsedFeedbackGate = segment.value
            case .exitCondition:
                parsedExitCondition = segment.value
            case .reviewBoundary:
                parsedReviewBoundary = segment.value
            case .outputShape:
                parsedOutputShape = segment.value
            case .skillPath:
                skillPathInstructions.append(segment.value)
            }
        }

        let removeBindings = Self.commandMatchedBindings(
            in: normalizedInstruction,
            labels: Self.removeCommandLabels,
            packages: packages,
            source: "builder-chat-remove"
        )
        let disableBindings = Self.commandMatchedBindings(
            in: normalizedInstruction,
            labels: Self.disableCommandLabels,
            packages: packages,
            source: "builder-chat-disable"
        )
        let enableBindings = Self.commandMatchedBindings(
            in: normalizedInstruction,
            labels: Self.enableCommandLabels,
            packages: packages,
            source: "builder-chat-enable"
        )
        let matchedKnowledgeSourceIDs = Self.commandMatchedKnowledgeSourceIDs(
            in: normalizedInstruction,
            labels: Self.knowledgeCommandLabels,
            knowledgeSources: knowledgeSources
        )
        let skillInstruction = skillPathInstructions.isEmpty
            ? normalizedInstruction
            : skillPathInstructions.joined(separator: "\n")
        let additiveSkillInstruction = Self.instructionRemovingCommandClauses(
            from: skillInstruction,
            labelGroups: [
                Self.removeCommandLabels,
                Self.disableCommandLabels,
                Self.enableCommandLabels,
                Self.knowledgeCommandLabels
            ]
        )
        let matchedBindings = Self.matchedSkillBindings(
            in: additiveSkillInstruction,
            packages: packages
        )
        let parsedSkillPathMode: SkillPathMode = skillPathInstructions.isEmpty ? .append : .replace
        if parsedSteps.isEmpty {
            let inferredSteps = Self.inferredSequencedSteps(from: normalizedInstruction)
            if !inferredSteps.isEmpty {
                parsedSteps = inferredSteps
                parsedStepMode = .replace
            }
        }
        if parsedFeedbackGate == nil {
            parsedFeedbackGate = Self.inferredClauseValue(from: normalizedInstruction, field: .feedbackGate)
        }
        if parsedExitCondition == nil {
            parsedExitCondition = Self.inferredClauseValue(from: normalizedInstruction, field: .exitCondition)
        }
        if parsedTrigger == nil {
            parsedTrigger = Self.inferredClauseValue(from: normalizedInstruction, field: .trigger)
        }
        if parsedOutputShape == nil {
            parsedOutputShape = Self.inferredClauseValue(from: normalizedInstruction, field: .outputShape)
        }

        if segments.isEmpty,
           matchedBindings.isEmpty,
           parsedSteps.isEmpty,
           parsedFeedbackGate == nil,
           parsedExitCondition == nil,
           parsedTrigger == nil,
           parsedOutputShape == nil,
           !normalizedInstruction.isEmpty {
            switch Self.inferredSingleField(from: normalizedInstruction) {
            case .steps:
                parsedSteps = [normalizedInstruction]
                parsedStepMode = .append
            case .feedbackGate:
                parsedFeedbackGate = normalizedInstruction
            case .exitCondition:
                parsedExitCondition = normalizedInstruction
            case .trigger:
                parsedTrigger = normalizedInstruction
            case .outputShape:
                parsedOutputShape = normalizedInstruction
            case .name, .goal, .inputBindings, .reviewBoundary:
                break
            case .skillPath:
                break
            case nil:
                parsedSteps = [normalizedInstruction]
                parsedStepMode = .append
            }
        }

        self.steps = Self.unique(parsedSteps)
        self.stepMode = parsedStepMode
        self.skillPathMode = parsedSkillPathMode
        self.name = parsedName
        self.goal = parsedGoal
        self.trigger = parsedTrigger
        self.inputBindings = Self.unique(parsedInputBindings)
        self.feedbackGate = parsedFeedbackGate
        self.exitCondition = parsedExitCondition
        self.reviewBoundary = parsedReviewBoundary
        self.outputShape = parsedOutputShape
        self.skillBindings = matchedBindings
        self.removedSkillBindings = removeBindings
        self.disabledSkillBindings = disableBindings
        self.enabledSkillBindings = enableBindings
        self.knowledgeSourceIDs = matchedKnowledgeSourceIDs
    }

    enum CodingKeys: String, CodingKey {
        case steps
        case stepMode
        case skillPathMode
        case name
        case goal
        case trigger
        case inputBindings
        case feedbackGate
        case exitCondition
        case reviewBoundary
        case outputShape
        case skillBindings
        case removedSkillBindings
        case disabledSkillBindings
        case enabledSkillBindings
        case knowledgeSourceIDs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        steps = try container.decode([String].self, forKey: .steps)
        stepMode = try container.decode(StepMode.self, forKey: .stepMode)
        skillPathMode = try container.decodeIfPresent(SkillPathMode.self, forKey: .skillPathMode) ?? .append
        name = try container.decodeIfPresent(String.self, forKey: .name)
        goal = try container.decodeIfPresent(String.self, forKey: .goal)
        trigger = try container.decodeIfPresent(String.self, forKey: .trigger)
        inputBindings = try container.decode([String].self, forKey: .inputBindings)
        feedbackGate = try container.decodeIfPresent(String.self, forKey: .feedbackGate)
        exitCondition = try container.decodeIfPresent(String.self, forKey: .exitCondition)
        reviewBoundary = try container.decodeIfPresent(String.self, forKey: .reviewBoundary)
        outputShape = try container.decodeIfPresent(String.self, forKey: .outputShape)
        skillBindings = try container.decode([LoopOpsSkillBinding].self, forKey: .skillBindings)
        removedSkillBindings = try container.decodeIfPresent([LoopOpsSkillBinding].self, forKey: .removedSkillBindings) ?? []
        disabledSkillBindings = try container.decodeIfPresent([LoopOpsSkillBinding].self, forKey: .disabledSkillBindings) ?? []
        enabledSkillBindings = try container.decodeIfPresent([LoopOpsSkillBinding].self, forKey: .enabledSkillBindings) ?? []
        knowledgeSourceIDs = try container.decodeIfPresent([String].self, forKey: .knowledgeSourceIDs) ?? []
    }

    var hasChanges: Bool {
        !steps.isEmpty
            || name != nil
            || goal != nil
            || trigger != nil
            || !inputBindings.isEmpty
            || feedbackGate != nil
            || exitCondition != nil
            || reviewBoundary != nil
            || outputShape != nil
            || !skillBindings.isEmpty
            || !removedSkillBindings.isEmpty
            || !disabledSkillBindings.isEmpty
            || !enabledSkillBindings.isEmpty
            || !knowledgeSourceIDs.isEmpty
    }

    var receiptStatus: String {
        hasChanges ? "Structured patch staged" : "No structured fields matched"
    }

    var receiptLines: [String] {
        var lines: [String] = []
        if !steps.isEmpty {
            let mode = stepMode == .replace ? "replaced" : "appended"
            lines.append("Steps \(mode): \(steps.count)")
        }
        if !skillBindings.isEmpty {
            let mode = skillPathMode == .replace ? "replaced" : "appended"
            lines.append("Skill path: \(skillBindings.map(\.title).joined(separator: " -> ")) [\(mode)]")
        }
        if !removedSkillBindings.isEmpty {
            lines.append("Skill path removed: \(removedSkillBindings.map(\.title).joined(separator: " -> "))")
        }
        if !disabledSkillBindings.isEmpty {
            lines.append("Skill path disabled: \(disabledSkillBindings.map(\.title).joined(separator: " -> "))")
        }
        if !enabledSkillBindings.isEmpty {
            lines.append("Skill path enabled: \(enabledSkillBindings.map(\.title).joined(separator: " -> "))")
        }
        if !knowledgeSourceIDs.isEmpty {
            lines.append("Knowledge attached: \(knowledgeSourceIDs.count)")
        }
        if let name {
            lines.append("Name: \(name)")
        }
        if let goal {
            lines.append("Goal: \(goal)")
        }
        if let trigger {
            lines.append("Trigger: \(trigger)")
        }
        if !inputBindings.isEmpty {
            lines.append("Input bindings: \(inputBindings.joined(separator: " -> "))")
        }
        if let feedbackGate {
            lines.append("Review rule: \(feedbackGate)")
        }
        if let exitCondition {
            lines.append("Exit condition: \(exitCondition)")
        }
        if let reviewBoundary {
            lines.append("Review boundary: \(reviewBoundary)")
        }
        if let outputShape {
            lines.append("Output shape: \(outputShape)")
        }
        if lines.isEmpty {
            lines.append("No Loop Contract fields were changed. Try name:, trigger:, inputs:, steps:, skill path:, review rule:, exit condition:, or output shape:.")
        }
        return lines
    }

    var receiptText: String {
        ([receiptStatus] + receiptLines.map { "- \($0)" }).joined(separator: "\n")
    }

    var receiptEvidence: String {
        [
            "steps=\(steps.count)",
            "step_mode=\(stepMode == .replace ? "replace" : "append")",
            "skill_path_mode=\(skillPathMode.rawValue)",
            "name=\(name == nil ? "unchanged" : "updated")",
            "goal=\(goal == nil ? "unchanged" : "updated")",
            "trigger=\(trigger == nil ? "unchanged" : "updated")",
            "input_bindings=\(inputBindings.count)",
            "skill_path=\(skillBindings.count)",
            "skill_remove=\(removedSkillBindings.count)",
            "skill_disable=\(disabledSkillBindings.count)",
            "skill_enable=\(enabledSkillBindings.count)",
            "knowledge=\(knowledgeSourceIDs.count)",
            "review_rule=\(feedbackGate == nil ? "unchanged" : "updated")",
            "exit_condition=\(exitCondition == nil ? "unchanged" : "updated")",
            "review_boundary=\(reviewBoundary == nil ? "unchanged" : "updated")",
            "output_shape=\(outputShape == nil ? "unchanged" : "updated")"
        ].joined(separator: "; ")
    }
}

enum LoopOpsBuilderPacketStatus: String, Codable, Hashable {
    case pending
    case applied
    case rejected
    case saved

    var title: String {
        switch self {
        case .pending: return "Pending"
        case .applied: return "Applied"
        case .rejected: return "Rejected"
        case .saved: return "Saved"
        }
    }
}

struct LoopOpsBuilderPacket: Identifiable, Codable, Hashable {
    var id: String
    var contractID: String
    var instruction: String
    var patch: LoopOpsBuilderDraftPatch
    var status: LoopOpsBuilderPacketStatus
    var createdAt: Date
    var updatedAt: Date

    init(
        id: String = "builder-packet-\(UUID().uuidString)",
        contractID: String,
        instruction: String,
        patch: LoopOpsBuilderDraftPatch,
        status: LoopOpsBuilderPacketStatus = .pending,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.contractID = contractID
        self.instruction = instruction
        self.patch = patch
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    var diffRows: [String] {
        patch.receiptLines
    }

    func updating(status: LoopOpsBuilderPacketStatus, at date: Date = Date()) -> LoopOpsBuilderPacket {
        var copy = self
        copy.status = status
        copy.updatedAt = date
        return copy
    }
}

struct LoopContractDraft: Identifiable, Hashable {
    var id: String
    var name: String
    var domain: WorkbenchDomain
    var goal: String
    var trigger: String
    var inputBindingsText: String
    var capabilityChainText: String
    var skillBindings: [LoopOpsSkillBinding]
    var stepSummaryText: String
    var feedbackGate: String
    var exitCondition: String
    var reviewBoundary: String
    var outputShape: String
    var prompt: String
    var knowledgeSourceIDs: [String] = []
    var skillStackID: String?

    static func from(contract: LoopContract) -> LoopContractDraft {
        LoopContractDraft(
            id: contract.id,
            name: contract.name,
            domain: contract.domain,
            goal: contract.goal,
            trigger: contract.trigger,
            inputBindingsText: contract.inputBindings.joined(separator: "\n"),
            capabilityChainText: contract.capabilityChain.joined(separator: "\n"),
            skillBindings: contract.orderedSkillBindings,
            stepSummaryText: contract.stepSummary.joined(separator: "\n"),
            feedbackGate: contract.feedbackGate,
            exitCondition: contract.exitCondition,
            reviewBoundary: contract.reviewBoundary,
            outputShape: contract.outputShape,
            prompt: contract.prompt,
            knowledgeSourceIDs: contract.knowledgeSourceIDs,
            skillStackID: contract.skillStackID
        )
    }

    func materialize(existing: LoopContract? = nil, now: Date = Date()) -> LoopContract {
        let orderedBindings = LoopOpsSkillBinding.ordered(skillBindings)
        let activeBindings = orderedBindings.filter(\.enabled)
        let skillIDs = activeBindings.filter { $0.kind == .skill }.map(\.id)
        let extensionIDs = activeBindings.filter { $0.kind == .extensionPackage }.map(\.id)
        let chain = orderedBindings.isEmpty
            ? capabilityChainText.linesForLoopOps()
            : orderedBindings.map(\.title)
        return LoopContract(
            id: id.isEmpty ? "loop-\(UUID().uuidString)" : id,
            name: name,
            domain: domain,
            goal: goal,
            trigger: trigger,
            inputBindings: inputBindingsText.linesForLoopOps(),
            capabilityChain: chain,
            skillBindings: orderedBindings,
            stepSummary: stepSummaryText.linesForLoopOps(),
            feedbackGate: feedbackGate,
            exitCondition: exitCondition,
            reviewBoundary: reviewBoundary,
            outputShape: outputShape,
            runMode: existing?.runMode ?? .manual,
            version: (existing?.version ?? 0) + 1,
            owner: existing?.owner ?? "local-user",
            visibility: existing?.visibility ?? "private",
            prompt: prompt,
            defaultSkillIDs: skillIDs,
            defaultExtensionIDs: extensionIDs,
            knowledgeSourceIDs: knowledgeSourceIDs,
            skillStackID: skillStackID,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
            installedFromTemplateID: existing?.installedFromTemplateID,
            workspaceCopyID: existing?.workspaceCopyID
        )
    }

    mutating func applySkillStack(_ stack: LoopOpsSkillStack) {
        skillStackID = stack.id
        skillBindings = LoopOpsSkillBinding.normalizeCurrentOrder(stack.bindings)
        syncCapabilityChainText()
    }

    mutating func applyCustomSkillBindings(_ bindings: [LoopOpsSkillBinding]) {
        skillStackID = nil
        skillBindings = LoopOpsSkillBinding.ordered(bindings)
        syncCapabilityChainText()
    }

    @discardableResult
    mutating func applyBuilderInstruction(
        _ instruction: String,
        packages: [LoopOpsSkillPackage],
        knowledgeSources: [LoopOpsKnowledgeSource] = []
    ) -> LoopOpsBuilderDraftPatch {
        let patch = LoopOpsBuilderDraftPatch(instruction: instruction, packages: packages, knowledgeSources: knowledgeSources)
        apply(patch)
        return patch
    }

    mutating func apply(_ patch: LoopOpsBuilderDraftPatch) {
        if !patch.steps.isEmpty {
            switch patch.stepMode {
            case .replace:
                stepSummaryText = patch.steps.joined(separator: "\n")
            case .append:
                stepSummaryText = appendUniqueLines(stepSummaryText.linesForLoopOps(), patch.steps)
                    .joined(separator: "\n")
            }
        }
        if let name = patch.name {
            self.name = name
        }
        if let goal = patch.goal {
            self.goal = goal
        }
        if let trigger = patch.trigger {
            self.trigger = trigger
        }
        if !patch.inputBindings.isEmpty {
            inputBindingsText = patch.inputBindings.joined(separator: "\n")
        }
        if let feedbackGate = patch.feedbackGate {
            self.feedbackGate = feedbackGate
        }
        if let exitCondition = patch.exitCondition {
            self.exitCondition = exitCondition
        }
        if let reviewBoundary = patch.reviewBoundary {
            self.reviewBoundary = reviewBoundary
        }
        if let outputShape = patch.outputShape {
            self.outputShape = outputShape
        }
        var pathMutated = false
        if !patch.removedSkillBindings.isEmpty {
            let removedKeys = Set(patch.removedSkillBindings.map(\.dragID))
            skillBindings.removeAll { removedKeys.contains($0.dragID) }
            skillBindings = LoopOpsSkillBinding.normalizeCurrentOrder(skillBindings)
            pathMutated = true
        }
        if !patch.disabledSkillBindings.isEmpty {
            let disabledKeys = Set(patch.disabledSkillBindings.map(\.dragID))
            skillBindings = LoopOpsSkillBinding.normalizeCurrentOrder(
                skillBindings.map { binding in
                    guard disabledKeys.contains(binding.dragID) else { return binding }
                    var copy = binding
                    copy.enabled = false
                    return copy
                }
            )
            pathMutated = true
        }
        if !patch.enabledSkillBindings.isEmpty {
            let enabledKeys = Set(patch.enabledSkillBindings.map(\.dragID))
            skillBindings = LoopOpsSkillBinding.normalizeCurrentOrder(
                skillBindings.map { binding in
                    guard enabledKeys.contains(binding.dragID) else { return binding }
                    var copy = binding
                    copy.enabled = true
                    return copy
                }
            )
            pathMutated = true
        }
        if !patch.skillBindings.isEmpty {
            switch patch.skillPathMode {
            case .replace:
                skillBindings = LoopOpsSkillBinding.normalizeCurrentOrder(patch.skillBindings)
            case .append:
                var bindings = skillBindings
                for binding in patch.skillBindings {
                    bindings.removeAll { $0.kind == binding.kind && $0.id == binding.id }
                    bindings.append(binding)
                }
                skillBindings = LoopOpsSkillBinding.ordered(bindings)
            }
            pathMutated = true
        }
        if !patch.knowledgeSourceIDs.isEmpty {
            knowledgeSourceIDs = appendUniqueLines(knowledgeSourceIDs, patch.knowledgeSourceIDs)
        }
        if pathMutated {
            skillStackID = nil
            syncCapabilityChainText()
        }
    }

    private mutating func syncCapabilityChainText() {
        capabilityChainText = skillBindings.map(\.title).joined(separator: "\n")
    }

    private func appendUniqueLines(_ existing: [String], _ additions: [String]) -> [String] {
        var values = existing
        var seen = Set(existing.map { $0.normalizedLoopOpsBuilderToken })
        for addition in additions {
            let key = addition.normalizedLoopOpsBuilderToken
            guard !key.isEmpty, !seen.contains(key) else { continue }
            values.append(addition)
            seen.insert(key)
        }
        return values
    }
}

private extension String {
    func linesForLoopOps() -> [String] {
        split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    var normalizedLoopOpsBuilderToken: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    var normalizedLoopOpsCommandToken: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
    }
}

private extension LoopOpsBuilderDraftPatch {
    static let removeCommandLabels = [
        "remove skill", "delete skill", "drop skill",
        "remove tool", "delete tool", "drop tool",
        "remove", "delete", "drop",
        "移除技能", "删除技能", "移除工具", "删除工具", "移除", "删除"
    ]

    static let disableCommandLabels = [
        "disable skill", "turn off skill", "deactivate skill",
        "disable tool", "turn off tool", "deactivate tool",
        "disable", "turn off", "deactivate",
        "禁用技能", "停用技能", "关闭技能", "禁用工具", "停用工具", "关闭工具", "禁用", "停用", "关闭"
    ]

    static let enableCommandLabels = [
        "enable skill", "turn on skill", "activate skill",
        "enable tool", "turn on tool", "activate tool",
        "enable", "turn on", "activate",
        "启用技能", "开启技能", "启用工具", "开启工具", "启用", "开启"
    ]

    static let knowledgeCommandLabels = [
        "attach knowledge", "use knowledge", "knowledge source", "knowledge",
        "绑定知识", "附加知识", "使用知识", "知识"
    ]

    enum Field {
        case name
        case goal
        case trigger
        case inputBindings
        case steps
        case feedbackGate
        case exitCondition
        case reviewBoundary
        case outputShape
        case skillPath
    }

    struct FieldMatch {
        var field: Field
        var range: Range<String.Index>
    }

    struct FieldSegment {
        var field: Field
        var value: String
        var stepMode: StepMode
    }

    static func fieldSegments(in text: String) -> [FieldSegment] {
        let matches = fieldMatches(in: text)
        return matches.enumerated().compactMap { index, match in
            let valueStart = match.range.upperBound
            let valueEnd = index + 1 < matches.count ? matches[index + 1].range.lowerBound : text.endIndex
            let boundedEnd = boundedFieldValueEnd(from: valueStart, to: valueEnd, field: match.field, in: text)
            let value = cleanFieldValue(String(text[valueStart..<boundedEnd]))
            guard !value.isEmpty else { return nil }
            return FieldSegment(
                field: match.field,
                value: match.field == .steps ? stepItems(from: value).joined(separator: "\n") : value,
                stepMode: stepMode(before: match.range, in: text)
            )
        }
    }

    static func fieldMatches(in text: String) -> [FieldMatch] {
        let labels: [(Field, [String])] = [
            (.name, ["loop name", "contract name", "name", "标题", "名称", "名字"]),
            (.goal, ["goal", "objective", "purpose", "目标", "目的"]),
            (.trigger, ["trigger", "schedule", "cadence", "run when", "触发器", "触发", "运行时间", "周期"]),
            (.inputBindings, ["input bindings", "inputs:", "inputs：", "input:", "input：", "输入绑定", "输入:", "输入：", "上下文:"]),
            (.feedbackGate, ["review rule", "reviewrule", "feedback gate", "feedbackgate", "gate", "反馈门", "反馈", "人工确认"]),
            (.exitCondition, ["exit condition", "exitcondition", "completion condition", "completion is", "done when", "完成条件", "退出条件", "停止条件"]),
            (.reviewBoundary, ["review boundary", "boundary", "safety boundary", "审批边界", "审查边界", "边界"]),
            (.outputShape, ["output shape", "outputshape", "output as", "output", "return as", "produce", "输出格式", "输出", "结果格式"]),
            (.skillPath, ["skill path", "skill stack", "capability chain", "execution path", "ordered skill path", "技能路径", "skill 路径", "能力链", "能力顺序", "执行路径", "工具路径", "调用顺序", "先后顺序"]),
            (.steps, ["step summary", "steps", "step", "步骤", "流程", "执行步骤", "完成步骤"])
        ]
        let orderedLabels = labels.flatMap { field, values in
            values.map { (field: field, label: $0) }
        }
        .sorted { lhs, rhs in
            lhs.label.count > rhs.label.count
        }

        var rawMatches: [FieldMatch] = []
        for item in orderedLabels {
            var searchStart = text.startIndex
            while searchStart < text.endIndex,
                  let range = text.range(
                    of: item.label,
                    options: [.caseInsensitive, .diacriticInsensitive],
                    range: searchStart..<text.endIndex
                  ) {
                if isFieldMarker(range: range, label: item.label, in: text) {
                    rawMatches.append(FieldMatch(field: item.field, range: range))
                }
                searchStart = range.upperBound
            }
        }

        return rawMatches
            .sorted { lhs, rhs in
                if lhs.range.lowerBound == rhs.range.lowerBound {
                    return text.distance(from: lhs.range.lowerBound, to: lhs.range.upperBound)
                        > text.distance(from: rhs.range.lowerBound, to: rhs.range.upperBound)
                }
                return lhs.range.lowerBound < rhs.range.lowerBound
            }
            .reduce(into: [FieldMatch]()) { matches, candidate in
                if let last = matches.last, candidate.range.lowerBound < last.range.upperBound {
                    return
                }
                matches.append(candidate)
            }
    }

    static func boundedFieldValueEnd(
        from valueStart: String.Index,
        to valueEnd: String.Index,
        field: Field,
        in text: String
    ) -> String.Index {
        guard field != .steps,
              let newline = text[valueStart..<valueEnd].firstIndex(of: "\n") else {
            return valueEnd
        }
        return newline
    }

    static func inferredSingleField(from text: String) -> Field? {
        let lowered = text.lowercased()
        if lowered.contains("exit") || lowered.contains("stop") || lowered.contains("complete") || text.contains("退出") || text.contains("完成") {
            return .exitCondition
        }
        if lowered.contains("trigger") || lowered.contains("schedule") || lowered.contains("cadence") || text.contains("触发") || text.contains("运行时间") {
            return .trigger
        }
        if lowered.contains("output") || lowered.contains("result") || text.contains("输出") || text.contains("结果") {
            return .outputShape
        }
        if lowered.contains("stale") || lowered.contains("wait") || lowered.contains("approve") || lowered.contains("gate") || text.contains("等待") || text.contains("人工") || text.contains("停止") {
            return .feedbackGate
        }
        return nil
    }

    static func inferredSequencedSteps(from text: String) -> [String] {
        guard let sequenceStart = firstSequenceStart(in: text) else { return [] }
        let sequenceText = String(text[sequenceStart...])
        let clauses = normalizedStepSeparators(in: sequenceText)
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "；", with: ";")
            .split(whereSeparator: { $0 == "\n" || $0 == ";" })
            .map { stripListPrefix(String($0)) }
            .filter { !$0.isEmpty }

        var steps: [String] = []
        for clause in clauses {
            if isUnstructuredFieldClause(clause) {
                break
            }
            steps.append(clause)
        }
        return unique(steps)
    }

    static func firstSequenceStart(in text: String) -> String.Index? {
        let markers = ["先", "首先", "第一步", "先用", "first", "first,", "start with"]
        return markers
            .compactMap { marker in
                text.range(of: marker, options: [.caseInsensitive, .diacriticInsensitive])?.lowerBound
            }
            .min()
    }

    static func isUnstructuredFieldClause(_ value: String) -> Bool {
        let lowered = value.lowercased()
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return lowered.hasPrefix("if ")
            || lowered.hasPrefix("when ")
            || lowered.hasPrefix("gate ")
            || lowered.hasPrefix("feedback ")
            || lowered.hasPrefix("exit ")
            || lowered.hasPrefix("stop ")
            || lowered.hasPrefix("finish ")
            || lowered.hasPrefix("complete ")
            || lowered.hasPrefix("done ")
            || lowered.hasPrefix("completion ")
            || lowered.hasPrefix("output shape")
            || lowered.hasPrefix("output format")
            || lowered.hasPrefix("output as")
            || lowered.hasPrefix("return ")
            || lowered.hasPrefix("produce ")
            || trimmed.hasPrefix("如果")
            || trimmed.hasPrefix("若")
            || trimmed.hasPrefix("当")
            || trimmed.hasPrefix("反馈")
            || trimmed.hasPrefix("人工确认")
            || trimmed.hasPrefix("退出条件")
            || trimmed.hasPrefix("完成条件")
            || trimmed.hasPrefix("停止条件")
            || trimmed.hasPrefix("输出格式")
            || trimmed.hasPrefix("结果格式")
    }

    static func inferredClauseValue(from text: String, field: Field) -> String? {
        clauses(from: text)
            .compactMap { clause in
                inferredValue(fromClause: clause, field: field)
            }
            .first
    }

    static func clauses(from text: String) -> [String] {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "；", with: ";")
            .split(whereSeparator: { $0 == "\n" || $0 == ";" })
            .map { cleanFieldValue(String($0)) }
            .filter { !$0.isEmpty }
    }

    static func inferredValue(fromClause clause: String, field: Field) -> String? {
        let lowered = clause.lowercased()
        switch field {
        case .name:
            let markers = ["loop name is", "contract name is", "name is", "名称是", "名称为", "名字是", "名字为", "标题是", "标题为"]
            return valueAfterAnyMarker(markers, in: clause)
        case .goal:
            let markers = ["goal is", "objective is", "purpose is", "目标是", "目标为", "目的为", "目的就是"]
            return valueAfterAnyMarker(markers, in: clause)
        case .trigger:
            let markers = ["trigger is", "trigger to", "schedule is", "schedule for", "cadence is", "run when", "触发器是", "触发器为", "触发改成", "触发为", "运行时间是", "运行时间为", "周期是", "周期为"]
            return valueAfterAnyMarker(markers, in: clause)
        case .inputBindings:
            let markers = ["input bindings are", "input bindings:", "inputs are", "input is", "输入绑定是", "输入绑定为", "输入是", "输入为"]
            return valueAfterAnyMarker(markers, in: clause)
        case .feedbackGate:
            let hasCondition = lowered.contains("if ") || lowered.contains("when ") || clause.contains("如果") || clause.contains("若") || clause.contains("当")
            let hasReview = lowered.contains("approval") || lowered.contains("approve") || lowered.contains("wait") || lowered.contains("stale") || lowered.contains("evidence") || clause.contains("人工") || clause.contains("确认") || clause.contains("证据")
            guard hasCondition && hasReview else { return nil }
            return clause
        case .exitCondition:
            let markers = ["完成条件是", "完成条件为", "退出条件是", "退出条件为", "停止条件是", "停止条件为", "finish when", "stop when", "exit when", "complete when", "done when", "completion is", "completion condition is"]
            return valueAfterAnyMarker(markers, in: clause)
        case .reviewBoundary:
            let markers = ["review boundary is", "boundary is", "safety boundary is", "审批边界是", "审批边界为", "审查边界是", "边界是", "边界为"]
            return valueAfterAnyMarker(markers, in: clause)
        case .outputShape:
            let markers = ["输出格式是", "输出格式为", "结果格式是", "结果格式为", "输出为", "输出成", "output shape is", "output should be", "output as", "return as", "format as", "produce"]
            return valueAfterAnyMarker(markers, in: clause)
        case .steps, .skillPath:
            return nil
        }
    }

    static func valueAfterAnyMarker(_ markers: [String], in text: String) -> String? {
        for marker in markers {
            guard let range = text.range(of: marker, options: [.caseInsensitive, .diacriticInsensitive]) else { continue }
            let value = cleanFieldValue(String(text[range.upperBound...]))
            if !value.isEmpty {
                return value
            }
        }
        return nil
    }

    static func matchedSkillBindings(
        in instruction: String,
        packages: [LoopOpsSkillPackage]
    ) -> [LoopOpsSkillBinding] {
        var seen = Set<String>()
        var matches: [(position: Int, packageIndex: Int, package: LoopOpsSkillPackage)] = []
        for (index, package) in packages.enumerated() {
            let key = "\(package.kind.rawValue):\(package.id)"
            guard !seen.contains(key),
                  let position = earliestPackageMentionPosition(package, in: instruction) else { continue }
            seen.insert(key)
            matches.append((position, index, package))
        }
        return matches
            .sorted {
                if $0.position == $1.position {
                    return $0.packageIndex < $1.packageIndex
                }
                return $0.position < $1.position
            }
            .enumerated()
            .map { order, match in
                match.package.binding(order: order, source: "builder-chat")
            }
    }

    static func earliestPackageMentionPosition(
        _ package: LoopOpsSkillPackage,
        in instruction: String
    ) -> Int? {
        packageMatchTerms(for: package)
            .compactMap { term -> Int? in
                guard let range = instruction.range(
                    of: term,
                    options: [.caseInsensitive, .diacriticInsensitive]
                ) else { return nil }
                return instruction.distance(from: instruction.startIndex, to: range.lowerBound)
            }
            .min()
    }

    static func packageMatchTerms(for package: LoopOpsSkillPackage) -> [String] {
        var terms = [
            package.title,
            package.id,
            package.id.replacingOccurrences(of: "-", with: " "),
            package.id.replacingOccurrences(of: "_", with: " ")
        ]
        let capabilitySuffix = " capability"
        if package.title.lowercased().hasSuffix(capabilitySuffix) {
            terms.append(String(package.title.dropLast(capabilitySuffix.count)))
        }
        return unique(terms)
            .filter { $0.count > 2 }
    }

    static func commandMatchedBindings(
        in instruction: String,
        labels: [String],
        packages: [LoopOpsSkillPackage],
        source: String
    ) -> [LoopOpsSkillBinding] {
        let items = commandTargetItems(in: instruction, labels: labels)
        var seen = Set<String>()
        var matches: [LoopOpsSkillBinding] = []
        for item in items {
            guard let package = packages.first(where: { commandItem(item, matches: $0) }) else { continue }
            let key = "\(package.kind.rawValue):\(package.id)"
            guard !seen.contains(key) else { continue }
            seen.insert(key)
            matches.append(package.binding(order: matches.count, source: source))
        }
        return matches
    }

    static func commandMatchedKnowledgeSourceIDs(
        in instruction: String,
        labels: [String],
        knowledgeSources: [LoopOpsKnowledgeSource]
    ) -> [String] {
        let items = commandTargetItems(in: instruction, labels: labels)
        var seen = Set<String>()
        var ids: [String] = []
        for item in items {
            guard let source = knowledgeSources.first(where: { commandItem(item, matchesKnowledgeSource: $0) }),
                  !seen.contains(source.id) else { continue }
            seen.insert(source.id)
            ids.append(source.id)
        }
        return ids
    }

    static func instructionRemovingCommandClauses(
        from instruction: String,
        labelGroups: [[String]]
    ) -> String {
        instruction
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "；", with: ";")
            .split(whereSeparator: { $0 == "\n" || $0 == ";" })
            .map(String.init)
            .filter { clause in
                !labelGroups.contains { labels in
                    commandLabelRange(in: clause, labels: labels) != nil
                }
            }
            .joined(separator: "\n")
    }

    static func commandTargetItems(in instruction: String, labels: [String]) -> [String] {
        instruction
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "；", with: ";")
            .split(whereSeparator: { $0 == "\n" || $0 == ";" })
            .flatMap { rawClause -> [String] in
                let clause = String(rawClause)
                guard let range = commandLabelRange(in: clause, labels: labels) else { return [] }
                let value = cleanFieldValue(String(clause[range.upperBound...]))
                return commandItems(from: value)
            }
    }

    static func commandLabelRange(in text: String, labels: [String]) -> Range<String.Index>? {
        labels
            .sorted { $0.count > $1.count }
            .compactMap { label -> Range<String.Index>? in
                guard let range = text.range(of: label, options: [.caseInsensitive, .diacriticInsensitive]),
                      isFieldMarker(range: range, label: label, in: text) else {
                    return nil
                }
                return range
            }
            .min { lhs, rhs in lhs.lowerBound < rhs.lowerBound }
    }

    static func commandItems(from value: String) -> [String] {
        normalizedStepSeparators(in: value)
            .replacingOccurrences(of: " and ", with: ";", options: [.caseInsensitive])
            .replacingOccurrences(of: "、", with: ";")
            .replacingOccurrences(of: "，", with: ";")
            .replacingOccurrences(of: ",", with: ";")
            .split(whereSeparator: { $0 == "\n" || $0 == ";" })
            .map { stripListPrefix(String($0)) }
            .filter { item in
                let token = item.normalizedLoopOpsCommandToken
                return token.count > 2 && token != "skill" && token != "tool" && token != "knowledge"
            }
    }

    static func commandItem(_ item: String, matches package: LoopOpsSkillPackage) -> Bool {
        let itemToken = item.normalizedLoopOpsCommandToken
        guard itemToken.count > 2 else { return false }
        return packageMatchTerms(for: package).contains { term in
            let termToken = term.normalizedLoopOpsCommandToken
            guard termToken.count > 2 else { return false }
            return itemToken == termToken
                || itemToken.contains(termToken)
                || (termToken.contains(itemToken) && itemToken.count > 5)
        }
    }

    static func commandItem(_ item: String, matchesKnowledgeSource source: LoopOpsKnowledgeSource) -> Bool {
        let itemToken = item.normalizedLoopOpsCommandToken
        guard itemToken.count > 2 else { return false }
        let terms = unique([source.title, source.id, source.sourceLabel])
        return terms.contains { term in
            let termToken = term.normalizedLoopOpsCommandToken
            guard termToken.count > 2 else { return false }
            return itemToken == termToken
                || itemToken.contains(termToken)
                || (termToken.contains(itemToken) && itemToken.count > 5)
        }
    }

    static func stepItems(from value: String) -> [String] {
        normalizedStepSeparators(in: value)
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "；", with: ";")
            .split(whereSeparator: { $0 == "\n" || $0 == ";" })
            .map { stripListPrefix(String($0)) }
            .filter { !$0.isEmpty }
    }

    static func normalizedStepSeparators(in value: String) -> String {
        var result = value
        [
            "，然后", ", then", ", Then",
            "，再", ", next", ", Next",
            "，最后", ", finally", ", Finally",
            "然后", " then ",
            "最后", " finally "
        ].forEach { marker in
            result = result.replacingOccurrences(of: marker, with: ";")
        }
        return result
    }

    static func stripListPrefix(_ value: String) -> String {
        var result = cleanFieldValue(value)
        while let first = result.first, first == "-" || first == "*" || first == "•" {
            result.removeFirst()
            result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        var index = result.startIndex
        while index < result.endIndex, result[index].isNumber {
            index = result.index(after: index)
        }
        if index > result.startIndex, index < result.endIndex, ".．)、:：".contains(result[index]) {
            result.removeSubrange(result.startIndex...index)
        }
        return cleanFieldValue(result)
    }

    static func stepMode(before range: Range<String.Index>, in text: String) -> StepMode {
        let lineStart = text[..<range.lowerBound].lastIndex(of: "\n").map { text.index(after: $0) } ?? text.startIndex
        let prefix = text[lineStart..<range.lowerBound].lowercased()
        if prefix.contains("add") || prefix.contains("append") || prefix.contains("追加") || prefix.contains("新增") || prefix.contains("加") {
            return .append
        }
        return .replace
    }

    static func cleanFieldValue(_ value: String) -> String {
        var result = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefixes = [
            ":", "：", "=", "-", "->",
            "please ", "update this loop to ", "to ",
            "first use ", "first ", "then use ", "then ", "next use ", "next ",
            "finally output ", "finally use ", "finally ", "lastly use ", "lastly ",
            "use ", "as ", "is ", "be ", "should ",
            "改成", "改为", "设为", "更新为", "首先", "先", "然后", "再", "最后", "使用", "用", "为", "成", "要", "需要"
        ]
        var removedPrefix = true
        while removedPrefix {
            removedPrefix = false
            for prefix in prefixes where result.localizedCaseInsensitiveContains(prefix) {
                if result.range(of: prefix, options: [.caseInsensitive])?.lowerBound == result.startIndex {
                    result.removeSubrange(result.startIndex..<result.index(result.startIndex, offsetBy: prefix.count))
                    result = result.trimmingCharacters(in: .whitespacesAndNewlines)
                    removedPrefix = true
                    break
                }
            }
        }
        while let last = result.last, ".。;；".contains(last) {
            result.removeLast()
            result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return result
    }

    static func isFieldMarker(range: Range<String.Index>, label: String, in text: String) -> Bool {
        let beforeOK: Bool
        if range.lowerBound == text.startIndex {
            beforeOK = true
        } else {
            let previous = text[text.index(before: range.lowerBound)]
            beforeOK = !previous.isLetter && !previous.isNumber
        }

        let afterOK: Bool
        if range.upperBound == text.endIndex {
            afterOK = true
        } else {
            let next = text[range.upperBound]
            afterOK = !next.isLetter && !next.isNumber
        }
        return beforeOK && afterOK
    }

    static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for value in values {
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
            let key = clean.normalizedLoopOpsBuilderToken
            guard !clean.isEmpty, !seen.contains(key) else { continue }
            result.append(clean)
            seen.insert(key)
        }
        return result
    }
}
