import SwiftUI
import UniformTypeIdentifiers

private struct LoopOpsChatContextAttachment: Identifiable, Hashable {
    let id = UUID().uuidString
    var kind: String
    var title: String
    var status: String
    var savedToKnowledge: Bool
    var systemImage: String

    var needsSource: Bool {
        status.localizedCaseInsensitiveContains("needs")
    }
}

private struct LoopOpsChatScopeContext: Identifiable, Hashable {
    var id: String
    var title: String
    var subtitle: String
    var status: String
    var systemImage: String
}

struct LoopOpsScopedChatPanel: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var store: LoopOpsLocalStore
    let scope: ChatScope
    let scopeID: String
    let title: String
    let selectedRun: WorkbenchLoopRunState?
    let selectedContract: LoopContract?
    var onBuilderInstruction: ((String) -> String?)? = nil
    var onReviewDecision: ((LoopOpsReviewDecisionAction) -> Void)? = nil

    @State private var draft = ""
    @State private var instantMode = true
    @State private var searchMode: LoopOpsChatSearchMode = .off
    @State private var temporaryChat = false
    @State private var selectedPromptCategory: String?
    @State private var stagedAttachments: [LoopOpsChatContextAttachment] = []
    @State private var hiddenScopeContextIDs: Set<String> = []

    private var thread: ChatThread? {
        store.existingThread(scope: scope, scopeID: scopeID)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(scope.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text(title)
                        .font(.system(size: 11.5))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                }
                Spacer()
                LoopOpsPill(text: scope.title, color: RadarTheme.blue, icon: "bubble.left.and.text.bubble.right")
            }

            scopeTargetCard

            VStack(alignment: .leading, spacing: 8) {
                if let messages = thread?.messages, !messages.isEmpty {
                    ForEach(messages.suffix(5)) { message in
                        LoopOpsChatBubble(message: message)
                    }
                } else {
                    LoopOpsEmptyText(
                        icon: "bubble.left",
                        title: "开始对话",
                        detail: emptyDetail
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            chatQuickControls
            inlineChatStates

            FlowLayout(spacing: 7) {
                ForEach(quickActions) { action in
                    LoopOpsQuickActionChip(action: action) {
                        perform(action)
                    }
                }
            }

            attachmentControls

            HStack(alignment: .bottom, spacing: 8) {
                TextField(promptPlaceholder, text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .lineLimit(2...4)
                    .padding(10)
                    .background(RadarTheme.panelElevated)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(RadarTheme.border, lineWidth: 1)
                    )
                    .onSubmit(send)
                    .accessibilityIdentifier(LoopOpsInteractionID.scopedChatInput(scope))
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .buttonStyle(HoverIconButtonStyle(size: 36))
                .accessibilityIdentifier(LoopOpsInteractionID.scopedChatSend(scope))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(RadarTheme.panel)
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(RadarTheme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityIdentifier(LoopOpsInteractionID.scopedChat(scope))
    }

    private var scopeTargetCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: "scope")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.blue)
                Text("Scope target")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                Spacer(minLength: 0)
                Text("\(visibleScopeContexts.count) contexts")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
            }
            FlowLayout(spacing: 7) {
                ForEach(visibleScopeContexts) { item in
                    HStack(spacing: 6) {
                        Image(systemName: item.systemImage)
                            .font(.system(size: 10, weight: .semibold))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title)
                                .font(.system(size: 10.5, weight: .semibold))
                                .lineLimit(1)
                            Text("\(item.subtitle) · \(item.status)")
                                .font(.system(size: 9.5))
                                .foregroundStyle(item.status.localizedCaseInsensitiveContains("needs") ? RadarTheme.gold : RadarTheme.mutedText)
                                .lineLimit(1)
                        }
                        Button {
                            hiddenScopeContextIDs.insert(item.id)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 9, weight: .bold))
                        }
                        .buttonStyle(.plain)
                        .help("Remove this context from the chat prompt")
                    }
                    .foregroundStyle(RadarTheme.secondaryText)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .background(RadarTheme.tintFaint)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                if visibleScopeContexts.isEmpty {
                    Button("Restore workspace scope") {
                        hiddenScopeContextIDs.removeAll()
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                }
            }
        }
        .padding(10)
        .background(RadarTheme.panelElevated.opacity(0.58))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .accessibilityIdentifier(LoopOpsInteractionID.scopedChatScopeTarget(scope))
    }

    private var inlineChatStates: some View {
        VStack(alignment: .leading, spacing: 6) {
            if searchMode != .off {
                LoopOpsInlineNotice(
                    icon: "magnifyingglass",
                    title: "Search \(searchMode.title)",
                    detail: "The next submitted run will include this search scope when available."
                )
            }
            if temporaryChat {
                LoopOpsInlineNotice(icon: "lock", title: "Temporary chat", detail: "Messages stay out of history and will not start a background run.")
            }
            if stagedAttachments.contains(where: \.needsSource) {
                LoopOpsInlineNotice(icon: "exclamationmark.triangle", title: "Attachment needs source", detail: "Complete the staged file, website, or knowledge note before relying on it.")
            }
            if selectedContract?.isRunnable == false {
                LoopOpsInlineNotice(icon: "wrench.and.screwdriver", title: "Needs setup", detail: "This Loop can be discussed here, but running it requires setup first.")
            }
        }
    }

    private var attachmentControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Menu {
                    Button {
                        stageAttachment(kind: "File", title: "File reference", status: "Needs file note", savedToKnowledge: false, systemImage: "paperclip")
                    } label: {
                        Label("Upload file reference", systemImage: "paperclip")
                    }
                    Button {
                        stageAttachment(kind: "Website", title: "Website source", status: "Needs URL", savedToKnowledge: false, systemImage: "globe")
                    } label: {
                        Label("Import website", systemImage: "globe")
                    }
                    Menu {
                        let sources = readyChatKnowledgeSources
                        if sources.isEmpty {
                            Text("No ready Knowledge sources")
                        } else {
                            ForEach(Array(sources.prefix(8))) { source in
                                Button {
                                    stageKnowledgeAttachment(source)
                                } label: {
                                    Label(source.title, systemImage: source.kind.systemImage)
                                }
                            }
                        }
                    } label: {
                        Label("Use Knowledge", systemImage: "tray.full")
                    }
                    Button {
                        let path = selectedContract?.orderedSkillPathLabels.joined(separator: " -> ")
                        stageAttachment(kind: "Tool", title: path?.isEmpty == false ? path! : "Skill OS path", status: selectedContract == nil ? "Needs loop" : "Ready", savedToKnowledge: false, systemImage: "wrench.and.screwdriver")
                    } label: {
                        Label("Use Skill OS path", systemImage: "wrench.and.screwdriver")
                    }
                } label: {
                    LoopOpsAttachmentChip(title: "Attach context", systemImage: "paperclip")
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .help("Stage context without opening system permission dialogs")
                .accessibilityIdentifier(LoopOpsInteractionID.scopedChatAttachMenu(scope))

                if !stagedAttachments.isEmpty {
                    Button("Clear") {
                        stagedAttachments.removeAll()
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                }
                Spacer(minLength: 0)
            }

            if !stagedAttachments.isEmpty {
                VStack(spacing: 6) {
                    ForEach(stagedAttachments) { attachment in
                        HStack(spacing: 8) {
                            Image(systemName: attachment.systemImage)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(attachment.needsSource ? RadarTheme.gold : RadarTheme.blue)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(attachment.kind): \(attachment.title)")
                                    .font(.system(size: 11.5, weight: .semibold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                    .lineLimit(1)
                                Text(attachment.savedToKnowledge ? "\(attachment.status) · saved in Knowledge" : attachment.status)
                                    .font(.system(size: 10.5))
                                    .foregroundStyle(attachment.needsSource ? RadarTheme.gold : RadarTheme.secondaryText)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            if !attachment.savedToKnowledge {
                                Button {
                                    saveAttachmentToKnowledge(attachment)
                                } label: {
                                    Image(systemName: "tray.and.arrow.down")
                                        .font(.system(size: 10, weight: .semibold))
                                }
                                .buttonStyle(HoverIconButtonStyle(size: 24))
                                .help("Save this staged context as a Knowledge source")
                            }
                            Button {
                                stagedAttachments.removeAll { $0.id == attachment.id }
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 10, weight: .bold))
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(8)
                        .background(RadarTheme.panelElevated)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.scopedChatAttachments(scope))
    }

    private func saveAttachmentToKnowledge(_ attachment: LoopOpsChatContextAttachment) {
        let source = store.saveChatAttachmentAsKnowledge(
            kind: attachment.kind,
            title: attachment.title,
            status: attachment.status,
            scope: scope,
            scopeID: scopeID
        )
        guard let index = stagedAttachments.firstIndex(where: { $0.id == attachment.id }) else { return }
        stagedAttachments[index].savedToKnowledge = true
        stagedAttachments[index].status = source.status == .ready ? "Ready" : "Needs review"
        stagedAttachments[index].title = source.title
    }

    private var visibleScopeContexts: [LoopOpsChatScopeContext] {
        scopeContexts.filter { !hiddenScopeContextIDs.contains($0.id) }
    }

    private var readyChatKnowledgeSources: [LoopOpsKnowledgeSource] {
        store.knowledgeSources.filter(\.canAttachToRun)
    }

    private var scopeContexts: [LoopOpsChatScopeContext] {
        var contexts: [LoopOpsChatScopeContext] = [
            LoopOpsChatScopeContext(id: "workspace", title: "Workspace", subtitle: "LoopOps", status: "Ready", systemImage: "rectangle.3.group")
        ]
        if let selectedContract {
            contexts.append(
                LoopOpsChatScopeContext(
                    id: "template-\(selectedContract.id)",
                    title: "Template: \(selectedContract.name)",
                    subtitle: selectedContract.domain.rawValue,
                    status: selectedContract.isRunnable ? "Ready" : "Needs setup",
                    systemImage: "doc.text"
                )
            )
        }
        if let selectedRun {
            contexts.append(
                LoopOpsChatScopeContext(
                    id: "run-\(selectedRun.task.runID)",
                    title: "Run: \(String(selectedRun.task.prompt.prefix(48)))",
                    subtitle: selectedRun.domain.rawValue,
                    status: selectedRun.statusLabel,
                    systemImage: "play.circle"
                )
            )
        }
        switch scope {
        case .builder:
            contexts.append(LoopOpsChatScopeContext(id: "builder-\(scopeID)", title: "Builder page", subtitle: title, status: "Editable", systemImage: "hammer"))
        case .review:
            contexts.append(LoopOpsChatScopeContext(id: "review-\(scopeID)", title: "Review packet", subtitle: title, status: "Review-only", systemImage: "checkmark.seal"))
        case .global, .run:
            break
        }
        return contexts
    }

    private var emptyDetail: String {
        switch scope {
        case .global:
            return "发起新 Loop、暂存材料说明或生成 Loop 草稿。"
        case .run:
            return "围绕当前结果解释、继续追问或生成下一轮 Loop。"
        case .builder:
            return "用自然语言修改 Loop 蓝图。"
        case .review:
            return "挑战结论、检查缺口或准备交付预览。"
        }
    }

    private var promptPlaceholder: String {
        let mode = instantMode ? "Instant" : "Deep"
        let search = "Search \(searchMode.title)"
        let persistence = temporaryChat ? "Temporary" : "Saved"
        switch scope {
        case .global: return "Ask or start a loop · \(viewModel.selectedAgentModelPreference.title) · \(mode) · \(search) · \(persistence)"
        case .run: return "Ask about this run · \(viewModel.selectedAgentModelPreference.title) · \(mode) · \(search) · \(persistence)"
        case .builder: return "Describe a loop edit · \(viewModel.selectedAgentModelPreference.title) · \(mode) · \(search) · \(persistence)"
        case .review: return "Ask review question · \(viewModel.selectedAgentModelPreference.title) · \(mode) · \(search) · \(persistence)"
        }
    }

    private var chatQuickControls: some View {
        VStack(alignment: .leading, spacing: 7) {
            FlowLayout(spacing: 7) {
                Button {
                    cycleModelPreference()
                } label: {
                    LoopOpsChatControlChip(
                        title: viewModel.selectedAgentModelPreference.title,
                        subtitle: "模型",
                        systemImage: "cpu",
                        active: viewModel.selectedAgentModelPreference != .auto
                    )
                }
                .buttonStyle(.plain)
                .help("切换模型偏好")
                .accessibilityIdentifier(LoopOpsInteractionID.scopedChatModelControl(scope))

                Button {
                    instantMode.toggle()
                } label: {
                    LoopOpsChatControlChip(
                        title: instantMode ? "Instant" : "Deep",
                        subtitle: "模式",
                        systemImage: instantMode ? "bolt.fill" : "scope",
                        active: instantMode
                    )
                }
                .buttonStyle(.plain)
                .help("切换响应深度")
                .accessibilityIdentifier(LoopOpsInteractionID.scopedChatInstantControl(scope))

                Button {
                    searchMode = searchMode.next
                } label: {
                    LoopOpsChatControlChip(
                        title: "Search \(searchMode.title)",
                        subtitle: "搜索",
                        systemImage: "magnifyingglass",
                        active: searchMode != .off
                    )
                }
                .buttonStyle(.plain)
                .help("切换 Off / Workspace / Web")
                .accessibilityIdentifier(LoopOpsInteractionID.scopedChatSearchControl(scope))

                Button {
                    temporaryChat.toggle()
                } label: {
                    LoopOpsChatControlChip(
                        title: "Temporary",
                        subtitle: temporaryChat ? "临时" : "保存",
                        systemImage: temporaryChat ? "lock.fill" : "tray.and.arrow.down",
                        active: temporaryChat
                    )
                }
                .buttonStyle(.plain)
                .help("临时消息不会写入当前对话记录")
                .accessibilityIdentifier(LoopOpsInteractionID.scopedChatTemporaryControl(scope))
            }
            .accessibilityIdentifier(LoopOpsInteractionID.scopedChatQuickControls(scope))

            FlowLayout(spacing: 7) {
                ForEach(promptCategories, id: \.title) { category in
                    Button {
                        selectedPromptCategory = category.title
                        draft = category.prompt
                    } label: {
                        Text(category.title)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(selectedPromptCategory == category.title ? RadarTheme.blue : RadarTheme.secondaryText)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 6)
                            .background(selectedPromptCategory == category.title ? RadarTheme.blue.opacity(0.14) : RadarTheme.tintFaint)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help(category.prompt)
                }
            }
            .accessibilityIdentifier(LoopOpsInteractionID.scopedChatPromptCategories(scope))
        }
    }

    private var promptCategories: [(title: String, prompt: String)] {
        switch scope {
        case .global:
            return [
                ("Create", "Create a new Loop page from this goal."),
                ("Explore", "Explore available loops, knowledge and tools for this task."),
                ("Code", "Prepare a builder-ready implementation note."),
                ("Learn", "Explain which saved knowledge should be attached.")
            ]
        case .run:
            return [
                ("Create", "Create a follow-up loop from this run."),
                ("Explore", "Explore evidence gaps and alternative readings."),
                ("Code", "Turn this result into a builder handoff patch."),
                ("Learn", "Explain what this run teaches the knowledge base.")
            ]
        case .builder:
            return [
                ("Create", "Create missing steps, review rules and output shape."),
                ("Explore", "Explore which skills should be in the execution path."),
                ("Code", "Write the ordered implementation steps."),
                ("Learn", "Explain the blueprint changes before saving.")
            ]
        case .review:
            return [
                ("Create", "Create a review checklist from the open questions."),
                ("Explore", "Explore claims that need human confirmation."),
                ("Code", "Draft a fix plan for the failed or weak step."),
                ("Learn", "Explain why this result is or is not safe to share.")
            ]
        }
    }

    private var quickActions: [LoopOpsQuickAction] {
        switch scope {
        case .global:
            return [
                LoopOpsQuickAction(id: "global-tool", title: "Choose tool", systemImage: "wrench.and.screwdriver", prompt: "Choose the best Skill OS tools for this task and explain the ordered path.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "global-knowledge", title: "Select knowledge", systemImage: "tray.full", prompt: "Select knowledge sources that should be attached before running.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "global-template", title: "Use template", systemImage: "square.stack.3d.up", prompt: "Use a Loop Library template for this request and show setup gaps.", kind: .createDraft)
            ]
        case .run:
            return [
                LoopOpsQuickAction(id: "run-explain", title: "Explain run", systemImage: "text.magnifyingglass", prompt: "Explain this run result, timeline, and review state.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "run-errors", title: "Show errors", systemImage: "exclamationmark.triangle", prompt: "Show errors, missing inputs, stale evidence and blocked actions for this run.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "run-retry", title: "Retry", systemImage: "arrow.clockwise", prompt: "Prepare a safe retry plan for this run without external side effects.", kind: .forkRun),
                LoopOpsQuickAction(id: "run-compare", title: "Compare", systemImage: "rectangle.split.2x1", prompt: "Compare this run with the previous run and list changed assumptions.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "run-export", title: "Export", systemImage: "square.and.arrow.up", prompt: "Prepare a share-safe export summary. Do not publish externally.", kind: .fillPrompt)
            ]
        case .builder:
            return [
                LoopOpsQuickAction(id: "builder-tool", title: "Choose tool", systemImage: "wrench.and.screwdriver", prompt: "Choose and order tools for this Loop execution path.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "builder-knowledge", title: "Select knowledge", systemImage: "tray.full", prompt: "Add the knowledge sources that this Loop should attach by default.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "builder-template", title: "Use template", systemImage: "square.stack.3d.up", prompt: "Adapt the closest Loop Library template to this draft.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "builder-test", title: "Test step", systemImage: "testtube.2", prompt: "Test the visible steps for missing inputs and review boundaries.", kind: .fillPrompt)
            ]
        case .review:
            return [
                LoopOpsQuickAction(id: "review-claims", title: "Check claims", systemImage: "checkmark.seal", prompt: "哪些 claim 需要人工确认？", kind: .fillPrompt),
                LoopOpsQuickAction(id: "review-errors", title: "Show errors", systemImage: "exclamationmark.triangle", prompt: "Show weak claims, missing evidence and blocked actions.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "review-compare", title: "Compare", systemImage: "rectangle.split.2x1", prompt: "Compare this packet against the source run and previous packet.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "review-publish", title: "Publish", systemImage: "paperplane", prompt: "Prepare a share-safe publish preview only; do not send externally.", kind: .fillPrompt),
                LoopOpsQuickAction(id: "review-export", title: "Export", systemImage: "square.and.arrow.up", prompt: "Export review notes into a share-safe summary.", kind: .markReviewed)
            ]
        }
    }

    private func perform(_ action: LoopOpsQuickAction) {
        switch action.kind {
        case .fillPrompt, .attachMedia:
            draft = action.prompt
        case .runNow, .forkRun, .createDraft, .markReviewed:
            if scope == .review, action.kind == .markReviewed {
                onReviewDecision?(.reviewed)
            }
            send(action.prompt)
        }
    }

    private func stageAttachment(kind: String, title: String, status: String, savedToKnowledge: Bool, systemImage: String) {
        let attachment = LoopOpsChatContextAttachment(
            kind: kind,
            title: LoopOpsPublicSkillPolicy.publicFacing(title),
            status: status,
            savedToKnowledge: savedToKnowledge,
            systemImage: systemImage
        )
        stagedAttachments.append(attachment)
        store.showToast(
            title: "Context staged",
            detail: "\(kind) context is staged; no system picker or permission dialog was opened.",
            tone: .info
        )
    }

    private func stageKnowledgeAttachment(_ source: LoopOpsKnowledgeSource) {
        let attachment = LoopOpsChatContextAttachment(
            kind: "Knowledge",
            title: LoopOpsPublicSkillPolicy.publicFacing(source.title),
            status: "Ready",
            savedToKnowledge: true,
            systemImage: source.kind.systemImage
        )
        stagedAttachments.append(attachment)
        if let selectedRun {
            _ = store.attachKnowledgeSource(
                id: source.id,
                toRunID: selectedRun.task.runID,
                runTitle: title
            )
            store.showToast(
                title: "Knowledge attached",
                detail: "\(source.title) will be included in the next Run Chat follow-up.",
                tone: .success
            )
        } else {
            store.showToast(
                title: "Knowledge staged",
                detail: "\(source.title) is staged for the next prompt.",
                tone: .info
            )
        }
    }

    private func send() {
        send(draft)
    }

    private func send(_ submittedText: String) {
        let text = submittedText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let assistantText: String
        if scope == .builder, !temporaryChat {
            assistantText = onBuilderInstruction?(text) ?? assistantReceipt(for: text)
        } else {
            assistantText = assistantReceipt(for: text)
        }

        if temporaryChat {
            store.showToast(
                title: "Temporary chat",
                detail: "这条消息未写入当前对话记录，也不会启动后台 run。",
                tone: .info
            )
        } else {
            store.appendMessage(
                scope: scope,
                scopeID: scopeID,
                title: title,
                role: .user,
                text: text,
                attachments: chatAttachments,
                controlMetadata: chatControlMetadata
            )
            store.appendMessage(scope: scope, scopeID: scopeID, title: title, role: .assistant, text: assistantText)
        }
        if !temporaryChat {
            submitIfNeeded(text)
        }
        draft = ""
        selectedPromptCategory = nil
        stagedAttachments.removeAll()
    }

    private func assistantReceipt(for text: String) -> String {
        switch scope {
        case .builder:
            return "已记录为 Builder Chat 指令；保存后会更新可见 Loop 蓝图。"
        case .review:
            return "已记录为 Review Chat 问题；不会执行外部动作。"
        case .run:
            return "已作为当前结果的追问提交到输入区。"
        case .global:
            return "已作为 LoopOps 全局请求提交。"
        }
    }

    private func submitIfNeeded(_ text: String) {
        guard scope == .global || scope == .run else { return }
        let submissionText = textWithQuickControls(text)
        if scope == .run, let selectedRun {
            let runInstruction = """
            基于当前选中的 Run 继续追问：\(submissionText)

            原任务：\(selectedRun.task.prompt)
            """
            if let selectedContract {
                viewModel.runLoopContract(
                    selectedContract,
                    additionalInstruction: runInstruction,
                    parentRunID: selectedRun.task.runID,
                    loopOpsStore: store
                )
            } else {
                viewModel.submitLoopOpsRunFollowUp(
                    prompt: submissionText,
                    selectedRun: selectedRun,
                    loopOpsStore: store
                )
            }
        } else if let selectedContract {
            viewModel.runLoopContract(selectedContract, additionalInstruction: submissionText, loopOpsStore: store)
        } else {
            viewModel.agentPrompt = submissionText
            viewModel.submitAgentPrompt()
        }
    }

    private func textWithQuickControls(_ text: String) -> String {
        let contextLines = visibleScopeContexts.map { "- \($0.title): \($0.subtitle), \($0.status)" }
        let attachmentLines = stagedAttachments.map { "- \($0.kind): \($0.title), \($0.status)" }
        let categoryLine = selectedPromptCategory.map { "Prompt category: \($0)" } ?? "Prompt category: None"
        return """
        \(text)

        Chat settings:
        Chat: \(scope.title)
        Model: \(viewModel.selectedAgentModelPreference.title)
        Mode: \(instantMode ? "Instant" : "Deep")
        Search: \(searchMode.title)
        Persistence: \(temporaryChat ? "Temporary, do not save to chat history" : "Save to chat history")
        \(categoryLine)
        Scope target:
        \(contextLines.isEmpty ? "- No explicit context" : contextLines.joined(separator: "\n"))
        Staged context:
        \(attachmentLines.isEmpty ? "- None" : attachmentLines.joined(separator: "\n"))
        """
    }

    private var chatControlMetadata: LoopOpsChatControlMetadata {
        LoopOpsChatControlMetadata(
            model: viewModel.selectedAgentModelPreference.title,
            mode: instantMode ? "Instant" : "Deep",
            searchMode: searchMode,
            temporary: temporaryChat,
            promptCategory: selectedPromptCategory,
            attachmentSummaries: stagedAttachments.map { "\($0.kind): \($0.title), \($0.status)" }
        )
    }

    private var chatAttachments: [LoopOpsChatAttachment] {
        stagedAttachments.map { attachment in
            LoopOpsChatAttachment(
                id: attachment.id,
                kind: attachmentKind(for: attachment.kind),
                fileName: "\(attachment.kind): \(attachment.title)",
                localPath: nil,
                artifactPath: attachment.savedToKnowledge ? "knowledge://\(attachment.title)" : nil,
                sha256: nil,
                sizeBytes: nil
            )
        }
    }

    private func attachmentKind(for rawKind: String) -> LoopOpsAttachmentKind {
        let value = rawKind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.contains("website") || value.contains("web") || value.contains("url") {
            return .link
        }
        if value.contains("image") {
            return .image
        }
        if value.contains("audio") {
            return .audio
        }
        if value.contains("video") {
            return .video
        }
        return .file
    }

    private func cycleModelPreference() {
        let all = AgentModelPreferenceOption.allCases
        guard let index = all.firstIndex(of: viewModel.selectedAgentModelPreference) else {
            viewModel.selectedAgentModelPreference = all.first ?? .auto
            return
        }
        viewModel.selectedAgentModelPreference = all[(index + 1) % all.count]
    }
}

struct LoopOpsLibraryView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var store: LoopOpsLocalStore
    let metrics: WorkbenchLayoutMetrics

    @State private var selectedContractID: String?
    @State private var selectedLedgerID: String?
    @State private var selectedContractIDs: Set<String> = []
    @State private var libraryQuery = ""
    @State private var libraryDomainFilter: WorkbenchDomain?
    @State private var libraryTypeFilter = "All templates"
    @State private var libraryAccessFilter = "All access"
    @State private var libraryTagFilter = "All tags"
    @State private var librarySort = "Recently updated"

    private var runStates: [WorkbenchLoopRunState] {
        viewModel.agentTasks
            .sorted { $0.updatedAt > $1.updatedAt }
            .map { rawTask in
                let task = viewModel.loopOpsTaskApplyingLifecycleOverride(rawTask)
                let loop = viewModel.agentCapabilityLoopByRunID[task.runID]
                return WorkbenchLoopRunState(
                    task: task,
                    domain: WorkbenchBlockClassifier.domain(for: task, capabilityLoop: loop),
                    capabilityLoop: loop,
                    finalReadModel: viewModel.agentFinalReadModelByRunID[task.runID]
                )
            }
    }

    private var liveLedgers: [RunLedgerRow] {
        runStates.map { run in
            decoratedLedger(RunLedgerRow.from(run: run, finalReadModel: viewModel.agentFinalReadModelByRunID[run.task.runID]))
        }
    }

    private var ledgers: [RunLedgerRow] {
        var rowsByRunID: [String: RunLedgerRow] = [:]
        for ledger in store.runLedgers {
            rowsByRunID[ledger.runID] = decoratedLedger(ledger)
        }
        for liveLedger in liveLedgers {
            if var stored = rowsByRunID[liveLedger.runID] {
                stored.status = liveLedger.status
                stored.completedAt = liveLedger.completedAt ?? stored.completedAt
                stored.finalAnswerPreview = liveLedger.finalAnswerPreview
                stored.evidenceGaps = liveLedger.evidenceGaps
                stored.blockedActions = liveLedger.blockedActions
                stored.reviewDecision = liveLedger.reviewDecision
                stored.followUpPrompts = liveLedger.followUpPrompts
                rowsByRunID[liveLedger.runID] = stored
            } else {
                rowsByRunID[liveLedger.runID] = liveLedger
            }
        }
        return rowsByRunID.values.sorted { ledgerSortKey($0) > ledgerSortKey($1) }
    }

    private var selectedContract: LoopContract? {
        if let selectedContractID,
           let found = store.allContractsForDisplay.first(where: { $0.id == selectedContractID }) {
            return found
        }
        return store.allContractsForDisplay.first
    }

    private var selectedListing: LoopOpsTemplateListing? {
        guard let selectedContract else { return nil }
        return listing(for: selectedContract)
    }

    private var selectedTemplateListings: [LoopOpsTemplateListing] {
        allTemplateListings.filter { selectedContractIDs.contains($0.id) }
    }

    private func listing(for contract: LoopContract) -> LoopOpsTemplateListing {
        LoopOpsTemplateListing.from(
            contract: contract,
            savedIDs: Set(store.loopContracts.map(\.id)),
            workspaceCopyIDsByTemplateID: store.installedWorkspaceCopyIDsByTemplateID
        )
    }

    private var allTemplateListings: [LoopOpsTemplateListing] {
        let savedIDs = Set(store.loopContracts.map(\.id))
        return store.allContractsForDisplay
            .map {
                LoopOpsTemplateListing.from(
                    contract: $0,
                    savedIDs: savedIDs,
                    workspaceCopyIDsByTemplateID: store.installedWorkspaceCopyIDsByTemplateID
                )
            }
    }

    private var templateListings: [LoopOpsTemplateListing] {
        let trimmed = libraryQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = allTemplateListings
            .filter { listing in
                let matchesDomain = libraryDomainFilter == nil || listing.domain == libraryDomainFilter
                let matchesType = libraryTypeFilter == "All templates" || listing.templateTypeLabel == libraryTypeFilter
                let matchesAccess = libraryAccessFilter == "All access" || listing.accessLabel == libraryAccessFilter || listing.installLabel == libraryAccessFilter
                let matchesTag = libraryTagFilter == "All tags" || listing.tagLabels.contains(libraryTagFilter)
                let searchable = [
                    listing.title,
                    listing.summary,
                    listing.creatorLabel,
                    listing.skillPath,
                    listing.templateTypeLabel,
                    listing.categoryLabel,
                    listing.accessLabel,
                    listing.integrationLabels.joined(separator: " "),
                    listing.requiredInputLabels.joined(separator: " "),
                    listing.requiredKnowledgeLabels.joined(separator: " "),
                    listing.requirementLabels.joined(separator: " "),
                    listing.tagLabels.joined(separator: " ")
                ].joined(separator: " ")
                let matchesQuery = trimmed.isEmpty || searchable.localizedCaseInsensitiveContains(trimmed)
                return matchesDomain && matchesType && matchesAccess && matchesTag && matchesQuery
            }
        return sortListings(filtered)
    }

    private var displayedTemplateListings: [LoopOpsTemplateListing] {
        Array(templateListings.prefix(14))
    }

    private var hiddenTemplateListingCount: Int {
        max(templateListings.count - displayedTemplateListings.count, 0)
    }

    private var readyTemplateListingCount: Int {
        templateListings.filter { $0.contract.isRunnable }.count
    }

    private var setupTemplateListingCount: Int {
        templateListings.count - readyTemplateListingCount
    }

    private var installedTemplateListingCount: Int {
        templateListings.filter { !$0.isInstallable }.count
    }

    private var typeFilterOptions: [String] {
        ["All templates"] + Array(Set(allTemplateListings.map(\.templateTypeLabel))).sorted()
    }

    private var accessFilterOptions: [String] {
        ["All access"] + Array(Set(allTemplateListings.map(\.accessLabel))).sorted()
    }

    private var tagFilterOptions: [String] {
        ["All tags"] + Array(Set(allTemplateListings.flatMap(\.tagLabels))).sorted()
    }

    private var hasSelectedInstallableTemplates: Bool {
        selectedTemplateListings.contains(where: \.isInstallable)
    }

    private var hasSelectedRunnableLoops: Bool {
        selectedTemplateListings.contains { !$0.isInstallable }
    }

    private func sortListings(_ listings: [LoopOpsTemplateListing]) -> [LoopOpsTemplateListing] {
        switch librarySort {
        case "Newest":
            return listings.sorted { $0.contract.createdAt > $1.contract.createdAt }
        case "Most used":
            return listings.sorted {
                let lhs = runCount(for: $0)
                let rhs = runCount(for: $1)
                if lhs == rhs { return $0.contract.updatedAt > $1.contract.updatedAt }
                return lhs > rhs
            }
        default:
            return listings.sorted { $0.contract.updatedAt > $1.contract.updatedAt }
        }
    }

    private func runCount(for listing: LoopOpsTemplateListing) -> Int {
        let ids = Set([listing.id, listing.workspaceCopyID, listing.contract.workspaceCopyID].compactMap { $0 })
        return ledgers.filter { ledger in
            guard let loopContractID = ledger.loopContractID else { return ledger.title == listing.title }
            return ids.contains(loopContractID)
        }.count
    }

    private var selectedLedger: RunLedgerRow? {
        if let selectedLedgerID,
           let found = ledgers.first(where: { $0.id == selectedLedgerID }) {
            return found
        }
        return ledgers.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LoopOpsPageHeader(
                title: "Loop Library",
                subtitle: "Saved loops, run records, review decisions and share-safe previews.",
                icon: "books.vertical",
                trailing: "\(store.allContractsForDisplay.count) loops"
            )

            if metrics.isCompact {
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    loopList
                    ledgerList
                    detailPanel
                }
            } else {
                HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                    VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                        loopList
                        ledgerList
                    }
                    .frame(width: metrics.queueColumnWidth)
                    detailPanel
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.loopLibrary)
    }

    private var loopList: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                PanelHeader(icon: "sparkle.magnifyingglass", title: "Loop Marketplace", trailing: "\(templateListings.count)")
                Spacer()
                Button {
                    installSelectedTemplates()
                } label: {
                    Label("Install selected", systemImage: "square.and.arrow.down")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .disabled(!hasSelectedInstallableTemplates)

                Button {
                    runSelectedLoops()
                } label: {
                    Label("Run selected", systemImage: "play.fill")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .disabled(!hasSelectedRunnableLoops)
                .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryBatchRun)
            }

            VStack(alignment: .leading, spacing: 8) {
                TextField("Search loops, skills, requirements...", text: $libraryQuery)
                    .loopOpsField()
                HStack(spacing: 8) {
                    Menu {
                        Button("All categories") { libraryDomainFilter = nil }
                        Divider()
                        ForEach(WorkbenchDomain.allCases) { domain in
                            Button(domain.title) { libraryDomainFilter = domain }
                        }
                    } label: {
                        Label(libraryDomainFilter?.title ?? "All categories", systemImage: "folder")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())

                    Menu {
                        ForEach(typeFilterOptions, id: \.self) { option in
                            Button(option) { libraryTypeFilter = option }
                        }
                    } label: {
                        Label(libraryTypeFilter, systemImage: "square.stack.3d.up")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())

                    Menu {
                        ForEach(accessFilterOptions, id: \.self) { option in
                            Button(option) { libraryAccessFilter = option }
                        }
                    } label: {
                        Label(libraryAccessFilter, systemImage: "key")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                }

                HStack(spacing: 8) {
                    Menu {
                        ForEach(tagFilterOptions.prefix(18), id: \.self) { option in
                            Button(option) { libraryTagFilter = option }
                        }
                    } label: {
                        Label(libraryTagFilter, systemImage: "tag")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())

                    Menu {
                        Button("Recently updated") { librarySort = "Recently updated" }
                        Button("Most used") { librarySort = "Most used" }
                        Button("Newest") { librarySort = "Newest" }
                    } label: {
                        Label(librarySort, systemImage: "arrow.up.arrow.down")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                }
            }

            LoopOpsLibrarySummaryStrip(
                shownCount: displayedTemplateListings.count,
                totalCount: templateListings.count,
                readyCount: readyTemplateListingCount,
                setupCount: setupTemplateListingCount,
                installedCount: installedTemplateListingCount
            )

            VStack(spacing: 0) {
                LoopOpsResourceTableHeader(columns: ["Loop Page", "Type", "Access", "Updated", "Readiness"])
                ForEach(displayedTemplateListings) { listing in
                    let contract = listing.contract
                    HStack(spacing: 8) {
                        Button {
                            toggleSelection(contract.id)
                        } label: {
                            Image(systemName: selectedContractIDs.contains(contract.id) ? "checkmark.square.fill" : "square")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(selectedContractIDs.contains(contract.id) ? RadarTheme.blue : RadarTheme.mutedText)
                        }
                        .buttonStyle(.plain)
                        .help("Select for batch run")
                        .accessibilityIdentifier(LoopOpsInteractionID.contractSelect(contract.id))

                        Button {
                            performLibraryPrimaryAction(for: listing)
                        } label: {
                            LoopOpsTemplateListingRow(listing: listing, selected: selectedContract?.id == contract.id)
                                .accessibilityIdentifier(LoopOpsInteractionID.contractRow(contract.id))
                        }
                        .buttonStyle(.plain)
                        .help(libraryPrimaryActionHelp(for: listing))
                        .accessibilityIdentifier(LoopOpsInteractionID.contractRow(contract.id))
                        .accessibilityAddTraits(.isButton)

                        Button {
                            selectedContractID = contract.id
                        } label: {
                            Image(systemName: "doc.text.magnifyingglass")
                        }
                        .buttonStyle(HoverIconButtonStyle(size: 30))
                        .help("Open loop page")
                        .accessibilityIdentifier(LoopOpsInteractionID.contractOpenButton(contract.id))

                        Button {
                            performLibraryPrimaryAction(for: listing)
                        } label: {
                            Image(systemName: listing.isInstallable ? "square.and.arrow.down" : "play.fill")
                        }
                        .buttonStyle(HoverIconButtonStyle(size: 30))
                        .help(libraryPrimaryActionHelp(for: listing))
                        .accessibilityIdentifier(listing.isInstallable ? LoopOpsInteractionID.contractInstallButton(contract.id) : LoopOpsInteractionID.contractRunButton(contract.id))
                    }
                    .contextMenu {
                        if listing.isInstallable {
                            Button("Install to Studio") {
                                install(contract)
                            }
                        } else {
                            Button("Run") {
                                run(store.actionContract(for: listing), switchToWorkbench: true)
                            }
                        }
                        Button("Open Page") { selectedContractID = contract.id }
                        Button("Clone") {
                            let cloned = store.clone(store.actionContract(for: listing))
                            selectedContractID = cloned.id
                            store.showToast(title: "Loop cloned", detail: "\(cloned.name) 已加入 Library。", tone: .success)
                        }
                    }
                    Divider().overlay(RadarTheme.borderSoft)
                }
                if hiddenTemplateListingCount > 0 {
                    HStack(spacing: 8) {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(RadarTheme.mutedText)
                        Text("\(hiddenTemplateListingCount) more loops are outside this view. Refine filters or sort to narrow the database.")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(RadarTheme.panelElevated.opacity(0.46))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
            )
            .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryTemplateMarketplace)

            if templateListings.isEmpty {
                LoopOpsEmptyText(icon: "magnifyingglass", title: "No loop templates", detail: "Adjust search or domain filters.")
            }
        }
        .padding(14)
        .radarPanel()
        .accessibilityIdentifier(LoopOpsInteractionID.buildAgentsList)
    }

    private var ledgerList: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "list.clipboard", title: "Run Records", trailing: "\(ledgers.count)")
            if ledgers.isEmpty {
                LoopOpsEmptyText(icon: "tray", title: "暂无运行记录", detail: "完成的 Loop 会出现在这里。")
            } else {
                ForEach(ledgers.prefix(8)) { ledger in
                    Button {
                        openLedgerInWorkbench(ledger)
                    } label: {
                        LoopOpsLedgerRow(ledger: ledger, selected: selectedLedger?.id == ledger.id)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(LoopOpsInteractionID.ledgerRow(ledger.id))
                    .contextMenu {
                        Button("Open Run Result") {
                            openLedgerInWorkbench(ledger)
                        }
                        Button("Select in Library") {
                            selectedLedgerID = ledger.id
                        }
                    }
                }
            }
        }
        .padding(14)
        .radarPanel()
        .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryLedgerList)
    }

    private var detailPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let selectedContract {
                VStack(alignment: .leading, spacing: 10) {
                    PanelHeader(icon: selectedContract.domain.systemImage, title: "Marketplace Listing", trailing: "v\(selectedContract.version)", tint: selectedContract.domain.tint)
                    Text(selectedContract.name)
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text(selectedContract.goal)
                        .font(.system(size: 13))
                        .foregroundStyle(RadarTheme.secondaryText)
                    if let selectedListing {
                        HStack(spacing: 6) {
                            LoopOpsPill(text: selectedListing.source.rawValue, color: RadarTheme.secondaryText, icon: "shippingbox")
                            LoopOpsPill(text: selectedListing.templateTypeLabel, color: RadarTheme.secondaryText, icon: "square.stack.3d.up")
                            LoopOpsPill(text: selectedListing.categoryLabel, color: selectedContract.domain.tint, icon: "folder")
                            LoopOpsPill(text: selectedListing.accessLabel, color: RadarTheme.blue, icon: "key")
                            LoopOpsPill(text: selectedListing.readinessLabel, color: selectedContract.isRunnable ? RadarTheme.green : RadarTheme.gold, icon: "checkmark.circle")
                        }

                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 10) {
                            LoopOpsKeyValue(label: "Creator / source", value: selectedListing.creatorLabel)
                            LoopOpsKeyValue(label: "Updated", value: selectedListing.updatedLabel)
                            LoopOpsKeyValue(label: "Integrations", value: selectedListing.integrationLabels.joined(separator: ", "))
                            LoopOpsKeyValue(label: "Required inputs", value: selectedListing.requiredInputLabels.joined(separator: ", "))
                            LoopOpsKeyValue(label: "Required knowledge", value: selectedListing.requiredKnowledgeLabels.joined(separator: ", "))
                            LoopOpsKeyValue(label: "Output shape", value: selectedContract.outputShape)
                        }

                        Divider().overlay(RadarTheme.borderSoft)
                        LoopOpsListingSection(title: "Execution path", icon: "point.3.connected.trianglepath.dotted") {
                            Text(selectedListing.skillPath.isEmpty ? "No execution path selected" : selectedListing.skillPath)
                                .font(.system(size: 12.5))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(3)
                        }
                        LoopOpsListingSection(title: "Preview steps", icon: "list.number") {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(selectedListing.stepPreview.enumerated()), id: \.offset) { index, step in
                                    HStack(alignment: .top, spacing: 8) {
                                        Text("\(index + 1)")
                                            .font(.system(size: 10.5, weight: .bold))
                                            .foregroundStyle(RadarTheme.blue)
                                            .frame(width: 18, height: 18)
                                            .background(RadarTheme.tintFaint)
                                            .clipShape(Circle())
                                        Text(step)
                                            .font(.system(size: 12))
                                            .foregroundStyle(RadarTheme.secondaryText)
                                            .lineLimit(3)
                                    }
                                }
                            }
                        }
                        LoopOpsListingSection(title: "Readiness checklist", icon: "checklist") {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(Array(selectedListing.readinessChecklist.enumerated()), id: \.offset) { _, item in
                                    HStack(alignment: .top, spacing: 7) {
                                        Image(systemName: selectedContract.isRunnable ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundStyle(selectedContract.isRunnable ? RadarTheme.green : RadarTheme.gold)
                                            .padding(.top, 1)
                                        Text(item)
                                            .font(.system(size: 12))
                                            .foregroundStyle(RadarTheme.secondaryText)
                                            .lineLimit(3)
                                    }
                                }
                            }
                        }
                        LoopOpsListingSection(title: "Example task", icon: "text.bubble") {
                            Text(selectedListing.exampleTask)
                                .font(.system(size: 12.5))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(6)
                                .textSelection(.enabled)
                        }
                        LoopOpsListingSection(title: "Sample output and limits", icon: "doc.text.magnifyingglass") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(selectedContract.outputShape)
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                    .lineLimit(3)
                                Text(LoopOpsPublicSkillPolicy.publicFacing(selectedContract.reviewBoundary))
                                    .font(.system(size: 12))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(4)
                            }
                        }
                        if let workspaceCopyID = selectedListing.workspaceCopyID {
                            LoopOpsKeyValue(label: "Install record", value: "Editable Studio copy: \(workspaceCopyID)")
                        } else if selectedListing.isInstallable {
                            LoopOpsKeyValue(label: "Install state", value: "Available template. Install to Studio before editing or running.")
                        }
                    }
                    LoopOpsKeyValue(label: "Trigger", value: selectedContract.trigger)
                    LoopOpsKeyValue(label: "Review Rule", value: LoopOpsPublicSkillPolicy.publicFacing(selectedContract.feedbackGate))
                    LoopOpsKeyValue(label: "Exit", value: selectedContract.exitCondition)
                    HStack(spacing: 8) {
                        if selectedListing?.isInstallable == true {
                            Button("Install to Studio") { install(selectedContract) }
                                .buttonStyle(ResearchPrimaryButtonStyle())
                                .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryDetailInstall)
                        } else {
                            let actionContract = selectedListing.map { store.actionContract(for: $0) } ?? selectedContract
                            Button(actionContract.isRunnable ? (actionContract.id == selectedContract.id ? "Run" : "Run copy") : "Finish setup") { replay(actionContract) }
                                .buttonStyle(ResearchPrimaryButtonStyle())
                                .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryDetailRun)
                        }
                        Button("Clone") {
                            let actionContract = selectedListing.map { store.actionContract(for: $0) } ?? selectedContract
                            let cloned = store.clone(actionContract)
                            selectedContractID = cloned.id
                            store.showToast(title: "Loop cloned", detail: "\(cloned.name) 已加入 Library。", tone: .success)
                        }
                            .buttonStyle(ResearchSecondaryButtonStyle())
                            .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryDetailClone)
                    }
                }
                .padding(14)
                .radarPanel()
            }

            if let selectedLedger {
                let packet = reviewPacket(for: selectedLedger)
                HStack(spacing: 8) {
                    Button {
                        openLedgerInWorkbench(selectedLedger)
                    } label: {
                        Label("Open Run Result", systemImage: "arrow.right.square")
                    }
                    .buttonStyle(ResearchPrimaryButtonStyle())
                    Button {
                        viewModel.selectLoopOpsRun(selectedLedger.runID)
                    } label: {
                        Label("Pin run", systemImage: "pin")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                }

                LoopOpsReviewDecisionPanel(
                    ledger: selectedLedger,
                    packet: packet,
                    onDecision: { action in
                        updateReviewDecision(action, for: selectedLedger)
                    }
                )
                .padding(14)
                .radarPanel()

                LoopOpsScopedChatPanel(
                    viewModel: viewModel,
                    store: store,
                    scope: .review,
                    scopeID: packet.id,
                    title: "\(selectedLedger.title) review",
                    selectedRun: runStates.first { $0.task.runID == selectedLedger.runID },
                    selectedContract: store.contract(for: selectedLedger),
                    onReviewDecision: { action in
                        updateReviewDecision(action, for: selectedLedger)
                    }
                )
                .padding(14)
                .radarPanel()

                let share = store.shareSafeLog(runID: selectedLedger.runID) ?? ShareSafeLogPreview.from(ledger: selectedLedger)
                VStack(alignment: .leading, spacing: 10) {
                    PanelHeader(icon: "square.and.arrow.up", title: "Share Preview", trailing: "private fields omitted")
                    Text(share.title)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    Text("Private inputs omitted; this preview is suitable for handoff, import, or clone review.")
                        .font(.system(size: 12))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(2)
                    LoopOpsKeyValue(label: "Safe Summary", value: share.redactedLoopSummary)
                    Text(share.finalAnswerExcerpt)
                        .font(.system(size: 13))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(6)
                        .textSelection(.enabled)
                    LoopOpsKeyValue(label: "Omitted", value: share.omittedSensitiveFieldsSummary)
                    LoopOpsKeyValue(label: "Clone / Reuse", value: share.cloneInstructions)
                    HStack(spacing: 8) {
                        Button("Open Run Result") { openLedgerInWorkbench(selectedLedger) }
                            .buttonStyle(ResearchPrimaryButtonStyle())
                        Button("Replay run") { replay(selectedLedger) }
                            .buttonStyle(ResearchSecondaryButtonStyle())
                        Button("Clone as private loop") {
                            if let contract = store.contract(for: selectedLedger) {
                                let cloned = store.clone(contract)
                                selectedContractID = cloned.id
                                store.showToast(title: "Loop cloned", detail: "\(cloned.name) 已加入 Library。", tone: .success)
                            }
                        }
                        .buttonStyle(ResearchSecondaryButtonStyle())
                    }
                }
                .padding(14)
                .radarPanel()
                .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryShareSafeLog)
            }
        }
    }

    private func installSelectedTemplates() {
        let installableContracts = selectedTemplateListings.filter(\.isInstallable).map(\.contract)
        guard !installableContracts.isEmpty else {
            store.showToast(title: "No installable templates", detail: "Select Marketplace templates that are not installed yet.", tone: .warning)
            return
        }
        let installedCopies = installableContracts.map { store.installTemplate($0) }
        for (template, copy) in zip(installableContracts, installedCopies) {
            writeInstallReceipt(template: template, copy: copy)
        }
        if let firstInstalled = installedCopies.first {
            selectedContractID = firstInstalled.id
            viewModel.loopOpsFocusedContractID = firstInstalled.id
            viewModel.select(workspace: .studio)
        }
        store.showToast(
            title: "Templates installed",
            detail: "\(installedCopies.count) editable Studio copy/copies created.",
            tone: .success
        )
    }

    private func runSelectedLoops() {
        let runnableContracts = uniqueContracts(selectedTemplateListings.filter { !$0.isInstallable }.map { store.actionContract(for: $0) })
        guard !runnableContracts.isEmpty else {
            store.showToast(title: "No runnable loops", detail: "Install Marketplace templates before running them.", tone: .warning)
            return
        }
        let report = viewModel.runLoopContracts(runnableContracts, loopOpsStore: store)
        if let firstSetupID = report.setupRequiredContractIDs.first {
            selectedContractID = firstSetupID
        } else if let firstRunnable = runnableContracts.first {
            selectedContractID = firstRunnable.id
        }
        if report.pendingCount > 0 || report.queuedCount > 0 {
            viewModel.select(workspace: .home)
        }
        store.showToast(
            title: report.setupRequiredCount == 0 ? "Loops submitting" : "Loops checked",
            detail: "\(report.pendingCount) submitting, \(report.queuedCount) queued, \(report.setupRequiredCount) need setup.",
            tone: report.setupRequiredCount == 0 ? .info : .warning
        )
    }

    private func replay(_ contract: LoopContract) {
        run(contract, switchToWorkbench: true)
    }

    private func openLedgerInWorkbench(_ ledger: RunLedgerRow) {
        selectedLedgerID = ledger.id
        viewModel.selectLoopOpsRun(ledger.runID)
        viewModel.select(workspace: .home)
        store.showToast(
            title: "Run Result opened",
            detail: "\(ledger.title) 已在 Workbench 选中。",
            tone: .info
        )
    }

    private func install(_ contract: LoopContract) {
        let copy = store.installTemplate(contract)
        selectedContractID = copy.id
        viewModel.loopOpsFocusedContractID = copy.id
        viewModel.select(workspace: .studio)
        writeInstallReceipt(template: contract, copy: copy)
        store.showToast(
            title: "Template installed",
            detail: "\(copy.name) 已加入 Studio，可继续配置。",
            tone: .success
        )
    }

    private func writeInstallReceipt(template: LoopContract, copy: LoopContract) {
        store.appendMessage(
            scope: .builder,
            scopeID: copy.id,
            title: copy.name,
            role: .assistant,
            text: "Installed from \(template.name). Review inputs, execution path, and output shape before running."
        )
    }

    private func performLibraryPrimaryAction(for listing: LoopOpsTemplateListing) {
        if listing.isInstallable {
            install(listing.contract)
        } else {
            run(store.actionContract(for: listing), switchToWorkbench: true)
        }
    }

    private func libraryPrimaryActionHelp(for listing: LoopOpsTemplateListing) -> String {
        if listing.isInstallable {
            return "Install to Studio"
        }
        return store.actionContract(for: listing).isRunnable ? "Run in background" : "Finish setup"
    }

    private func uniqueContracts(_ contracts: [LoopContract]) -> [LoopContract] {
        var seen: Set<String> = []
        var unique: [LoopContract] = []
        for contract in contracts where seen.insert(contract.id).inserted {
            unique.append(contract)
        }
        return unique
    }

    private func run(_ contract: LoopContract, switchToWorkbench: Bool = false) {
        selectedContractID = contract.id
        let report = viewModel.runLoopContract(contract, loopOpsStore: store)
        if report.pendingCount > 0 {
            store.showToast(
                title: "Loop submitting",
                detail: "\(contract.name) is waiting for run confirmation.",
                tone: .info
            )
        } else if report.queuedCount > 0 {
            store.showToast(
                title: "Loop queued",
                detail: "\(contract.name) 正在后台运行。",
                tone: .success
            )
        }
        if switchToWorkbench && (report.pendingCount > 0 || report.queuedCount > 0) {
            viewModel.select(workspace: .home)
        }
    }

    private func replay(_ ledger: RunLedgerRow) {
        if let contract = store.contract(for: ledger) {
            let report = viewModel.runLoopContract(contract, additionalInstruction: "Replay this run from the share-safe log.", loopOpsStore: store)
            if report.pendingCount > 0 || report.queuedCount > 0 {
                viewModel.select(workspace: .home)
            }
            return
        }
        viewModel.agentPrompt = "重新运行这个 Loop：\(ledger.title)\n请基于当前可用上下文重新运行，并保留人工复核边界。"
        viewModel.submitAgentPrompt()
        viewModel.select(workspace: .home)
    }

    private func reviewPacket(for ledger: RunLedgerRow) -> ReviewPacketViewModel {
        if let packet = store.reviewPacket(runID: ledger.runID) {
            return packet
        }
        if let run = runStates.first(where: { $0.task.runID == ledger.runID }) {
            return ReviewPacketViewModel.from(
                task: run.task,
                domain: run.domain,
                finalReadModel: viewModel.agentFinalReadModelByRunID[ledger.runID]
            )
        }
        return ReviewPacketViewModel(
            id: ledger.runID,
            runID: ledger.runID,
            finalAnswer: ledger.finalAnswerPreview,
            domainSummary: "\(ledger.domain.title) review checklist",
            claims: ledger.finalAnswerPreview.isEmpty ? [] : [String(ledger.finalAnswerPreview.prefix(140))],
            evidenceGaps: ledger.evidenceGaps,
            uncertainty: ledger.status,
            blockedActions: ledger.blockedActions,
            nextQuestions: ledger.followUpPrompts.isEmpty ? ["需要补充哪些输入？", "是否要 fork 成下一轮 loop？"] : ledger.followUpPrompts,
            reviewDecision: ledger.reviewDecision,
            reviewNotes: "Review packet assembled from the run ledger.",
            eventHistory: (ledger.lifecycleEvents ?? []).enumerated().map { index, event in
                LoopOpsReviewPacketEvent(
                    id: "review-event-\(ledger.runID)-ledger-\(index)",
                    kind: "ledger",
                    title: event,
                    actor: "Run Ledger",
                    occurredAt: ledger.completedAt ?? ledger.startedAt ?? AgentDateFormatting.isoString(Date())
                )
            }
        )
    }

    private func updateReviewDecision(_ action: LoopOpsReviewDecisionAction, for ledger: RunLedgerRow) {
        let packet = reviewPacket(for: ledger).applyingReviewDecision(
            action.decisionValue,
            notes: "\(action.title) from Loop Library review controls.",
            actor: "local-user"
        )
        store.upsertReviewPacket(packet)
        let updatedLedger = ledger.applyingReviewPacket(packet)
        store.captureRunLedger(updatedLedger)
    }

    private func toggleSelection(_ id: String) {
        if selectedContractIDs.contains(id) {
            selectedContractIDs.remove(id)
        } else {
            selectedContractIDs.insert(id)
        }
    }

    private func decoratedLedger(_ ledger: RunLedgerRow) -> RunLedgerRow {
        if let packet = store.reviewPacket(runID: ledger.runID) {
            return ledger.applyingReviewPacket(packet)
        }
        return ledger
    }

    private func ledgerSortKey(_ ledger: RunLedgerRow) -> String {
        ledger.completedAt ?? ledger.startedAt ?? ledger.runID
    }
}

private enum LoopOpsToolKindFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case skills = "Skills"
    case extensions = "Extensions"

    var id: String { rawValue }

    func accepts(_ package: LoopOpsSkillPackage) -> Bool {
        switch self {
        case .all:
            return true
        case .skills:
            return package.kind == .skill
        case .extensions:
            return package.kind == .extensionPackage
        }
    }
}

private enum LoopOpsToolColumn: String, CaseIterable, Identifiable, Hashable {
    case name
    case type
    case integrations
    case usedBy
    case owner
    case status
    case modified

    var id: String { rawValue }

    var title: String {
        switch self {
        case .name:
            return "Tool name"
        case .type:
            return "Type"
        case .integrations:
            return "Integrations"
        case .usedBy:
            return "Used by"
        case .owner:
            return "Owner"
        case .status:
            return "Status"
        case .modified:
            return "Last modified"
        }
    }

    var width: CGFloat? {
        switch self {
        case .name:
            return nil
        case .type:
            return 82
        case .integrations:
            return 116
        case .usedBy:
            return 86
        case .owner:
            return 76
        case .status:
            return 88
        case .modified:
            return 102
        }
    }
}

private enum LoopOpsToolStatusFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case enabled = "Enabled"
    case available = "Available"

    var id: String { rawValue }

    func accepts(_ package: LoopOpsSkillPackage) -> Bool {
        switch self {
        case .all:
            return true
        case .enabled:
            return package.selected
        case .available:
            return !package.status.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
}

private enum LoopOpsToolSort: String, CaseIterable, Identifiable {
    case modified = "Last modified"
    case name = "Name"
    case kind = "Type"
    case integrations = "Integrations"
    case status = "Status"

    var id: String { rawValue }
}

private enum LoopOpsToolViewMode: String, CaseIterable, Identifiable {
    case list = "List"
    case grid = "Grid"

    var id: String { rawValue }
}

private enum LoopOpsToolDetailTab: String, CaseIterable, Identifiable {
    case run = "Use"
    case build = "Build"
    case logs = "Logs"

    var id: String { rawValue }
}

private enum LoopOpsToolLogStatusFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case success = "Success"
    case failed = "Failed"
    case updates = "Updates"
    case running = "Running"
    case needsInput = "Needs input"

    var id: String { rawValue }

    func accepts(_ log: LoopOpsToolLog) -> Bool {
        switch self {
        case .all:
            return true
        case .success:
            return log.canonicalStatus == .succeeded
        case .failed:
            return log.canonicalStatus == .failed || log.canonicalStatus == .blocked
        case .updates:
            return log.canonicalStatus == .draft
                || log.canonicalStatus == .validated
                || log.publicTitle.localizedCaseInsensitiveContains("updated")
        case .running:
            return log.canonicalStatus == .submitting
                || log.canonicalStatus == .waiting
                || log.canonicalStatus == .running
        case .needsInput:
            return log.publicReviewState.localizedCaseInsensitiveContains("input")
                || log.publicOutputOrErrorSummary.localizedCaseInsensitiveContains("missing")
        }
    }
}

private enum LoopOpsToolLogUserFilter: String, CaseIterable, Identifiable {
    case all = "All users"
    case you = "You"
    case workspace = "Workspace"
    case run = "Run"

    var id: String { rawValue }

    func accepts(_ log: LoopOpsToolLog) -> Bool {
        switch self {
        case .all:
            return true
        case .you, .workspace, .run:
            return log.resolvedUserLabel == rawValue
        }
    }
}

private struct LoopOpsToolStartingPoint: Identifiable, Hashable {
    let id: String
    let title: String
    let summary: String
    let prompt: String
    let draftName: String
    let purpose: String
    let inputScope: String
    let inputs: [String]
    let visibleSteps: [String]
    let outputShape: String
    let reviewPolicy: String

    var interactionID: String {
        switch id {
        case "Default":
            return LoopOpsInteractionID.skillOSCreateToolDefault
        case "Import":
            return LoopOpsInteractionID.skillOSCreateToolImport
        default:
            return LoopOpsInteractionID.skillOSCreateToolInvent
        }
    }

    static let all: [LoopOpsToolStartingPoint] = [
        LoopOpsToolStartingPoint(
            id: "Invent",
            title: "Describe task",
            summary: "Describe a repeated review task and turn it into a local Skill OS tool draft.",
            prompt: "Create a read-only loop tool that checks market evidence freshness and returns a review checklist.",
            draftName: "Evidence Gap Finder",
            purpose: "Draft a reusable review-only tool from task notes.",
            inputScope: "Review checklist",
            inputs: ["Review checklist", "Evidence notes", "Current workspace context"],
            visibleSteps: ["Collect reviewer notes", "Detect stale or missing evidence", "Write evidence gaps", "Wait for user confirmation"],
            outputShape: "Evidence gaps, review checklist, next questions",
            reviewPolicy: "No external sending or live execution without explicit confirmation."
        ),
        LoopOpsToolStartingPoint(
            id: "Default",
            title: "Start from blank",
            summary: "Start with blank operational fields, then wire the tool to a run context.",
            prompt: "Create a blank review-only tool with manual inputs and a final answer output.",
            draftName: "Default Runner",
            purpose: "Create a clean starter tool for run review work.",
            inputScope: "Run context",
            inputs: ["Run context", "Manual notes", "Selected execution path"],
            visibleSteps: ["Collect inputs", "Run selected execution path", "Write final answer draft", "Wait for user confirmation"],
            outputShape: "Final answer, evidence gaps, review checklist",
            reviewPolicy: "Review-only. Do not send, publish, trade, or execute outside the local run."
        ),
        LoopOpsToolStartingPoint(
            id: "Import",
            title: "Import",
            summary: "Normalize an existing tool definition into Skill OS and tag the source in logs.",
            prompt: "Import an existing review tool definition, normalize inputs and outputs, then write a source-tagged log row.",
            draftName: "Imported Review Tool",
            purpose: "Bring an existing definition into Skill OS as a review-only local draft.",
            inputScope: "Builder note",
            inputs: ["Tool definition URL or JSON", "Builder note", "Review policy notes"],
            visibleSteps: ["Parse imported definition", "Map inputs and outputs", "Convert steps to review-only flow", "Write import log"],
            outputShape: "Imported tool draft, validation notes, review gaps",
            reviewPolicy: "Imported tools stay local until the user explicitly confirms any external action."
        )
    ]

    static func selected(_ id: String) -> LoopOpsToolStartingPoint {
        all.first { $0.id == id } ?? all[0]
    }

    static let inputScopes = ["Run context", "Builder note", "Review checklist"]

    static func inputs(for scope: String, fallback: [String]) -> [String] {
        switch scope {
        case "Run context":
            return ["Run context", "Manual notes", "Selected execution path"]
        case "Builder note":
            return ["Tool definition URL or JSON", "Builder note", "Review policy notes"]
        case "Review checklist":
            return ["Review checklist", "Evidence notes", "Current workspace context"]
        default:
            return fallback
        }
    }
}

struct LoopOpsSkillOSView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var store: LoopOpsLocalStore
    let metrics: WorkbenchLayoutMetrics

    @State private var query = ""
    @State private var selectedPackageID: String?
    @State private var stackName = "Untitled Skill Stack"
    @State private var activeStackID: String?
    @State private var activeStackBindings: [LoopOpsSkillBinding] = []
    @State private var kindFilter: LoopOpsToolKindFilter = .all
    @State private var statusFilter: LoopOpsToolStatusFilter = .all
    @State private var domainFilter = "All"
    @State private var sortOption: LoopOpsToolSort = .modified
    @State private var visibleToolColumns: Set<LoopOpsToolColumn> = Set(LoopOpsToolColumn.allCases)
    @State private var viewMode: LoopOpsToolViewMode = .list
    @State private var selectedToolTab: LoopOpsToolDetailTab = .run
    @State private var createToolPresented = false
    @State private var createToolMode = "Invent"
    @State private var createToolName = LoopOpsToolStartingPoint.selected("Invent").draftName
    @State private var createToolIntegration = "Local Tool"
    @State private var createToolInputScope = LoopOpsToolStartingPoint.selected("Invent").inputScope
    @State private var createToolPrompt = "Create a read-only loop tool that checks market evidence freshness and returns a review checklist."
    @State private var createToolStepsText = LoopOpsToolStartingPoint.selected("Invent").visibleSteps.joined(separator: "\n")
    @State private var createToolOutput = LoopOpsToolStartingPoint.selected("Invent").outputShape
    @State private var createToolReviewRule = LoopOpsToolStartingPoint.selected("Invent").reviewPolicy
    @State private var createToolValidationIssues: [String] = []
    @State private var draftPendingDeletion: LoopOpsToolDraft?
    @State private var toolRunInputsByDraftID: [String: [String: String]] = [:]
    @State private var toolRunValidationByDraftID: [String: [String]] = [:]
    @State private var toolBuildIntegrationTextByDraftID: [String: String] = [:]
    @State private var toolBuildInputScopeTextByDraftID: [String: String] = [:]
    @State private var toolBuildInputsTextByDraftID: [String: String] = [:]
    @State private var toolBuildStepsTextByDraftID: [String: String] = [:]
    @State private var toolBuildOutputTextByDraftID: [String: String] = [:]
    @State private var toolBuildReviewRuleTextByDraftID: [String: String] = [:]
    @State private var toolBuildValidationByDraftID: [String: [String]] = [:]
    @State private var toolLogStatusFilter: LoopOpsToolLogStatusFilter = .all
    @State private var toolLogUserFilter: LoopOpsToolLogUserFilter = .all
    @State private var toolLogQuery = ""
    @State private var toolLogShowsAllActivity = false
    @State private var selectedToolReviewLogID: String?

    private var allPackages: [LoopOpsSkillPackage] {
        LoopOpsSkillPackage.packages(from: viewModel, toolDrafts: store.toolDrafts)
    }

    private var selectedToolReviewLog: LoopOpsToolLog? {
        guard let selectedToolReviewLogID else { return nil }
        return store.toolLogs.first { $0.id == selectedToolReviewLogID }
    }

    private var domainOptions: [String] {
        ["All"] + Array(Set(allPackages.map(\.domainLabel))).sorted()
    }

    private var packages: [LoopOpsSkillPackage] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = allPackages.filter { package in
            let matchesQuery = trimmed.isEmpty
                || "\(package.title) \(package.description) \(package.category ?? "") \(package.domainLabel) \(package.integrationLabel) \(package.usedByLabel) \(package.ownerLabel) \(package.updatedLabel)"
                    .localizedCaseInsensitiveContains(trimmed)
            let matchesDomain = domainFilter == "All" || package.domainLabel == domainFilter
            return matchesQuery && matchesDomain && kindFilter.accepts(package) && statusFilter.accepts(package)
        }
        switch sortOption {
        case .modified:
            return filtered.sorted { packageSortDate($0) > packageSortDate($1) }
        case .name:
            return filtered.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .kind:
            return filtered.sorted { $0.kind.title.localizedCaseInsensitiveCompare($1.kind.title) == .orderedAscending }
        case .integrations:
            return filtered.sorted { $0.integrationLabel.localizedCaseInsensitiveCompare($1.integrationLabel) == .orderedAscending }
        case .status:
            return filtered.sorted { $0.status.localizedCaseInsensitiveCompare($1.status) == .orderedAscending }
        }
    }

    private func packageSortDate(_ package: LoopOpsSkillPackage) -> Date {
        package.lastModifiedAt ?? .distantPast
    }

    private var selectedPackage: LoopOpsSkillPackage? {
        if let selectedPackageID {
            return packages.first { $0.id == selectedPackageID }
        }
        return packages.first
    }

    private var selectedToolDraft: LoopOpsToolDraft? {
        guard let selectedPackage else { return nil }
        return store.toolDrafts.first { $0.id == selectedPackage.id }
    }

    private var activeRunLedger: RunLedgerRow? {
        if let runID = viewModel.selectedLoopOpsRunID,
           let ledger = store.runLedger(runID: runID) {
            return ledger
        }
        return store.runLedgers.first
    }

    private var selectedStartingPoint: LoopOpsToolStartingPoint {
        LoopOpsToolStartingPoint.selected(createToolMode)
    }

    private var selectedBindings: [LoopOpsSkillBinding] {
        let selected = allPackages
            .filter(\.selected)
            .enumerated()
            .map { index, package in package.binding(order: index, source: "selected") }
        return LoopOpsSkillBinding.ordered(selected)
    }

    private var activeStackBindingsForDisplay: [LoopOpsSkillBinding] {
        LoopOpsSkillBinding.ordered(activeStackBindings)
    }

    private var selectedActiveStack: LoopOpsSkillStack? {
        guard let activeStackID else { return nil }
        return store.allSkillStacksForDisplay.first { $0.id == activeStackID }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LoopOpsPageHeader(
                title: "Skill OS",
                subtitle: "Manage skills, tools, history, and reusable execution paths.",
                icon: "square.stack.3d.up",
                trailing: "\(packages.count) tools"
            )

            if metrics.isCompact {
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    packageLibrary
                    stackLibrary
                    packageDetail
                }
            } else {
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                        packageLibrary
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                        packageDetail
                            .frame(width: metrics.supportColumnWidth)
                    }
                    HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                        stackLibrary
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                        LoopOpsToolSelectionSummary(bindings: selectedBindings)
                            .frame(width: metrics.supportColumnWidth)
                    }
                }
            }
        }
        .onAppear(perform: loadInitialActiveStack)
        .accessibilityIdentifier("loopops.skill-os")
        .confirmationDialog(
            "Delete local tool?",
            isPresented: Binding(
                get: { draftPendingDeletion != nil },
                set: { if !$0 { draftPendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let draft = draftPendingDeletion {
                Button("Delete \(draft.name)", role: .destructive) {
                    deleteLocalToolDraft(draft)
                    draftPendingDeletion = nil
                }
            }
            Button("Cancel", role: .cancel) {
                draftPendingDeletion = nil
            }
        } message: {
            if let draft = draftPendingDeletion {
                Text("This removes \(draft.name) from Skill OS and saved stacks. Existing run logs stay available for review.")
            }
        }
    }

    private var packageLibrary: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                PanelHeader(icon: "wrench.and.screwdriver", title: "Tools", trailing: "\(packages.count) of \(allPackages.count)")
                Spacer()
                Button {
                    createToolPresented = true
                } label: {
                    Label("New Tool", systemImage: "plus")
                }
                .buttonStyle(ResearchPrimaryButtonStyle())
                .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateTool)
                .sheet(isPresented: $createToolPresented) {
                    createToolSheet
                }
            }
            LoopOpsManagementHero(
                title: "Tools database",
                subtitle: "Default skills, imported tools, and reusable stacks stay organized in one database.",
                icon: "sparkles",
                segments: LoopOpsToolStartingPoint.all.map(\.title)
            )
            toolToolbar
            if packages.isEmpty {
                LoopOpsEmptyText(icon: "magnifyingglass", title: "No tools match", detail: "Adjust search or filters to find a skill.")
            } else if viewMode == .list {
                toolTable
            } else {
                toolGrid
            }
        }
        .padding(14)
        .radarPanel()
        .accessibilityIdentifier(LoopOpsInteractionID.buildToolsList)
    }

    private var toolToolbar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                TextField("Search tools...", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .foregroundStyle(RadarTheme.primaryText)
                    .accessibilityIdentifier(LoopOpsInteractionID.skillOSSearch)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(minWidth: 220, maxWidth: .infinity, alignment: .leading)
            .background(RadarTheme.panelElevated)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
            )

            Menu {
                Picker("Type", selection: $kindFilter) {
                    ForEach(LoopOpsToolKindFilter.allCases) { filter in
                        Text(filter.rawValue).tag(filter)
                    }
                }
                Picker("Domain", selection: $domainFilter) {
                    ForEach(domainOptions, id: \.self) { domain in
                        Text(domain).tag(domain)
                    }
                }
                Picker("Status", selection: $statusFilter) {
                    ForEach(LoopOpsToolStatusFilter.allCases) { filter in
                        Text(filter.rawValue).tag(filter)
                    }
                }
            } label: {
                Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
            .accessibilityIdentifier(LoopOpsInteractionID.skillOSFilter)

            Menu {
                ForEach(LoopOpsToolColumn.allCases) { column in
                    Button {
                        toggleColumn(column)
                    } label: {
                        Label(column.title, systemImage: visibleToolColumns.contains(column) ? "checkmark" : "circle")
                    }
                    .disabled(visibleToolColumns.count == 1 && visibleToolColumns.contains(column))
                }
            } label: {
                Label("Columns: \(visibleToolColumns.count)", systemImage: "rectangle.split.3x1")
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
            .accessibilityIdentifier(LoopOpsInteractionID.skillOSColumns)

            Menu {
                Picker("Sort", selection: $sortOption) {
                    ForEach(LoopOpsToolSort.allCases) { option in
                        Text(option.rawValue).tag(option)
                    }
                }
            } label: {
                Label("Sort: \(sortOption.rawValue)", systemImage: "arrow.up.arrow.down")
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
            .accessibilityIdentifier(LoopOpsInteractionID.skillOSSort)

            Button {
                viewMode = .list
            } label: {
                Image(systemName: "list.bullet")
            }
            .buttonStyle(HoverIconButtonStyle(size: 34))
            .accessibilityIdentifier(LoopOpsInteractionID.skillOSListMode)

            Button {
                viewMode = .grid
            } label: {
                Image(systemName: "square.grid.2x2")
            }
            .buttonStyle(HoverIconButtonStyle(size: 34))
            .accessibilityIdentifier(LoopOpsInteractionID.skillOSGridMode)
        }
    }

    private var toolTable: some View {
        VStack(spacing: 0) {
            LoopOpsToolTableHeader(columns: visibleToolColumns)
            ForEach(packages) { package in
                Button {
                    selectedPackageID = package.id
                } label: {
                    LoopOpsSkillPackageTableRow(package: package, selected: selectedPackageID == package.id, columns: visibleToolColumns)
                }
                .buttonStyle(.plain)
                .onDrag { NSItemProvider(object: package.dragPayload as NSString) }
                .accessibilityIdentifier(LoopOpsInteractionID.skillPackage(package.id))
                .contextMenu {
                    Button("Inspect") { selectedPackageID = package.id }
                    Button("Add to active stack") { addToActiveStack(package) }
                    Button("Enable") {
                        if !package.selected { toggle(package) }
                    }
                    Button("Disable") {
                        if package.selected { toggle(package) }
                    }
                    if let draft = localToolDraft(for: package) {
                        Divider()
                        Button("Delete Local Tool", role: .destructive) {
                            draftPendingDeletion = draft
                        }
                    }
                }
                Divider().overlay(RadarTheme.borderSoft)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .accessibilityIdentifier(LoopOpsInteractionID.skillOSLibrary)
    }

    private var toolGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 10)], alignment: .leading, spacing: 10) {
            ForEach(packages) { package in
                Button {
                    selectedPackageID = package.id
                } label: {
                    LoopOpsSkillPackageRow(package: package, selected: selectedPackageID == package.id)
                }
                .buttonStyle(.plain)
                .onDrag { NSItemProvider(object: package.dragPayload as NSString) }
                .accessibilityIdentifier(LoopOpsInteractionID.skillPackage(package.id))
                .contextMenu {
                    Button("Inspect") { selectedPackageID = package.id }
                    Button("Add to active stack") { addToActiveStack(package) }
                }
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.skillOSLibrary)
    }

    private var stackLibrary: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                PanelHeader(icon: "list.bullet.rectangle", title: "Stack Builder", trailing: "\(activeStackBindingsForDisplay.count) steps")
                Spacer()
                Menu {
                    Button("New empty stack") {
                        activeStackID = nil
                        activeStackBindings = []
                        stackName = "Untitled Skill Stack"
                    }
                    Divider()
                    ForEach(store.allSkillStacksForDisplay) { stack in
                        Button(stack.name) {
                            load(stack)
                        }
                    }
                } label: {
                    Label(selectedActiveStack?.name ?? "New stack", systemImage: "square.stack.3d.up")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
            HStack(spacing: 8) {
                TextField("Stack name", text: $stackName)
                    .loopOpsField()
                Button {
                    saveActiveStack()
                } label: {
                    Label("Save", systemImage: "tray.and.arrow.down")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .disabled(activeStackBindingsForDisplay.isEmpty)
                Button {
                    applyActiveStackToSelection()
                } label: {
                    Label("Enable", systemImage: "checkmark.circle")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .disabled(activeStackBindingsForDisplay.isEmpty)
            }
            LoopOpsSkillPathEditor(
                bindings: $activeStackBindings,
                stacks: store.allSkillStacksForDisplay,
                title: "Active Stack",
                applyDrop: applyActiveStackDrop(_:before:),
                onManualEdit: {}
            )
            Divider().overlay(RadarTheme.borderSoft)
            ForEach(store.allSkillStacksForDisplay.prefix(8)) { stack in
                LoopOpsSkillStackRow(stack: stack)
                    .onDrag { NSItemProvider(object: "loopops-stack|\(stack.id)" as NSString) }
                    .contextMenu {
                        Button("Edit stack") { load(stack) }
                        Button("Enable stack tools") { apply(stack) }
                        Button("Append to builder") {
                            activeStackBindings = LoopOpsSkillBinding.normalizeCurrentOrder(activeStackBindingsForDisplay + stack.bindings)
                        }
                        if !store.starterSkillStacks.map(\.id).contains(stack.id) {
                            Button("Delete", role: .destructive) { store.deleteSkillStack(id: stack.id) }
                        }
                    }
            }
        }
        .padding(14)
        .radarPanel()
        .accessibilityIdentifier(LoopOpsInteractionID.skillOSStackLibrary)
    }

    private var packageDetail: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(icon: "doc.text.magnifyingglass", title: "Skill Page", trailing: selectedPackage?.domainLabel ?? "Local")
            if let selectedPackage {
                Picker("Tool detail", selection: $selectedToolTab) {
                    ForEach(LoopOpsToolDetailTab.allCases) { tab in
                        Text(tab.rawValue).tag(tab)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)

                switch selectedToolTab {
                case .run:
                    toolRunPanel(selectedPackage)
                case .build:
                    toolBuildPanel(selectedPackage)
                case .logs:
                    toolLogsPanel(selectedPackage)
                }
            } else {
                LoopOpsEmptyText(icon: "square.stack.3d.up", title: "Select a skill", detail: "Pick any row to inspect it or drag it into Studio.")
            }
        }
        .padding(14)
        .radarPanel()
        .accessibilityIdentifier(LoopOpsInteractionID.skillOSDetailPage)
    }

    private func toolRunPanel(_ selectedPackage: LoopOpsSkillPackage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let draft = selectedToolDraft {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(draft.name)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(2)
                        Text(draft.purpose)
                            .font(.system(size: 11.5))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(3)
                    }
                    Spacer(minLength: 0)
                    LoopOpsPill(text: draft.isEnabled ? "Enabled" : "Draft", color: draft.isEnabled ? RadarTheme.green : RadarTheme.blue, icon: "checkmark.circle")
                }
                LoopOpsKeyValue(label: "Expected output", value: draft.outputSummary)
                Divider().overlay(RadarTheme.borderSoft)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Required inputs")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                    if draft.requiredInputs.isEmpty {
                        LoopOpsEmptyText(icon: "text.badge.checkmark", title: "No required fields", detail: "This local draft can run from the current workspace context.")
                    } else {
                        ForEach(draft.requiredInputs, id: \.self) { input in
                            let missing = (toolRunValidationByDraftID[draft.id] ?? []).contains(input)
                            VStack(alignment: .leading, spacing: 5) {
                                HStack(spacing: 6) {
                                    Text(input)
                                        .font(.system(size: 10.5, weight: .semibold))
                                        .foregroundStyle(RadarTheme.mutedText)
                                    if missing {
                                        Text("Required")
                                            .font(.system(size: 10.5, weight: .semibold))
                                            .foregroundStyle(RadarTheme.red)
                                    }
                                }
                                TextField("Enter \(input.lowercased())", text: toolInputBinding(for: draft, input: input), axis: .vertical)
                                    .lineLimit(2...4)
                                    .loopOpsField()
                            }
                        }
                    }
                }
                if let issues = toolRunValidationByDraftID[draft.id], !issues.isEmpty {
                    LoopOpsInlineNotice(
                        icon: "exclamationmark.triangle",
                        title: "Missing input",
                        detail: issues.joined(separator: ", ")
                    )
                }
                HStack(spacing: 8) {
                    Button {
                        addToActiveStack(selectedPackage)
                    } label: {
                        Label("Add to stack", systemImage: "plus")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    Button {
                        runToolDraft(draft)
                    } label: {
                        Label("Run Tool", systemImage: "play.fill")
                    }
                    .buttonStyle(ResearchPrimaryButtonStyle())
                    .accessibilityIdentifier(LoopOpsInteractionID.skillOSEnableAction)
                    Button("Clear") {
                        toolRunInputsByDraftID[draft.id] = [:]
                        toolRunValidationByDraftID[draft.id] = []
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    Button("Delete") {
                        draftPendingDeletion = draft
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .foregroundStyle(RadarTheme.red)
                    .accessibilityIdentifier(LoopOpsInteractionID.skillOSDeleteAction)
                }
            } else {
                LoopOpsKeyValue(label: "Name", value: selectedPackage.title)
                LoopOpsKeyValue(label: "Kind", value: selectedPackage.kind.title)
                LoopOpsKeyValue(label: "Status", value: selectedPackage.selected ? "Enabled" : selectedPackage.status)
                LoopOpsKeyValue(label: "Summary", value: selectedPackage.description)
                HStack(spacing: 8) {
                    Button("Enable") {
                        if !selectedPackage.selected { toggle(selectedPackage) }
                    }
                    .buttonStyle(ResearchPrimaryButtonStyle())
                    .disabled(selectedPackage.selected)
                    .accessibilityIdentifier(LoopOpsInteractionID.skillOSEnableAction)
                    Button("Disable") {
                        if selectedPackage.selected { toggle(selectedPackage) }
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .disabled(!selectedPackage.selected)
                    .accessibilityIdentifier(LoopOpsInteractionID.skillOSDisableAction)
                    Button {
                        addToActiveStack(selectedPackage)
                    } label: {
                        Label("Add to stack", systemImage: "plus")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    Button {
                        let stack = LoopOpsSkillStack(
                            name: "\(selectedPackage.title) Stack",
                            summary: selectedPackage.description,
                            bindings: [selectedPackage.binding(order: 0, source: "single-skill")]
                        )
                        store.upsertSkillStack(stack)
                        store.showToast(title: "Stack saved", detail: "\(stack.name) 已加入 Skill Stacks。", tone: .success)
                    } label: {
                        Label("Save as stack", systemImage: "plus.rectangle.on.folder")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                }
            }
        }
    }

    private func toolBuildPanel(_ selectedPackage: LoopOpsSkillPackage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let draft = selectedToolDraft {
                LoopOpsKeyValue(label: "Purpose", value: draft.purpose)
                LoopOpsSkillPathList(bindings: draft.skillBindings.isEmpty ? [selectedPackage.binding(order: 0, source: "local-tool-draft")] : draft.skillBindings, title: "Execution Path")
                Divider().overlay(RadarTheme.borderSoft)
                VStack(alignment: .leading, spacing: 6) {
                    Text("Source")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    TextField("Integration or local source", text: buildIntegrationBinding(for: draft))
                        .loopOpsField()
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Allowed context")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    TextField("What context this tool can read", text: buildInputScopeBinding(for: draft), axis: .vertical)
                        .lineLimit(2...4)
                        .loopOpsField()
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Required inputs")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    TextField("One input per line", text: buildInputsBinding(for: draft), axis: .vertical)
                        .lineLimit(3...6)
                        .loopOpsField()
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Visible steps")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    TextField("One step per line", text: buildStepsBinding(for: draft), axis: .vertical)
                        .lineLimit(5...8)
                        .loopOpsField()
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Expected outputs")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    TextField("Describe the output users should review", text: buildOutputBinding(for: draft), axis: .vertical)
                        .lineLimit(3...6)
                        .loopOpsField()
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Review rule")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    TextField("What must stay review-only or confirmed", text: buildReviewRuleBinding(for: draft), axis: .vertical)
                        .lineLimit(2...4)
                        .loopOpsField()
                }
                if let issues = toolBuildValidationByDraftID[draft.id], !issues.isEmpty {
                    LoopOpsInlineNotice(icon: "exclamationmark.triangle", title: "Build needs detail", detail: issues.joined(separator: ", "))
                }
                HStack(spacing: 8) {
                    Button {
                        saveToolDraftBuild(draft)
                    } label: {
                        Label("Save Build", systemImage: "tray.and.arrow.down")
                    }
                    .buttonStyle(ResearchPrimaryButtonStyle())
                    Button("Reset") {
                        toolBuildIntegrationTextByDraftID[draft.id] = draft.resolvedIntegrationSource
                        toolBuildInputScopeTextByDraftID[draft.id] = draft.resolvedInputScope
                        toolBuildInputsTextByDraftID[draft.id] = draft.inputs.joined(separator: "\n")
                        toolBuildStepsTextByDraftID[draft.id] = draft.visibleSteps.joined(separator: "\n")
                        toolBuildOutputTextByDraftID[draft.id] = draft.outputShape
                        toolBuildReviewRuleTextByDraftID[draft.id] = draft.reviewPolicy
                        toolBuildValidationByDraftID[draft.id] = []
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                }
            } else {
                LoopOpsKeyValue(label: "Purpose", value: selectedPackage.description)
                LoopOpsSkillPathList(bindings: [selectedPackage.binding(order: 0, source: "tool-page")], title: "Execution Path")
                LoopOpsEmptyText(
                    icon: "wrench.adjustable",
                    title: "Create a reusable tool",
                    detail: "Use New Tool to draft inputs, visible steps, output shape and review policy before saving a stack."
                )
            }
        }
    }

    private func toolLogsPanel(_ selectedPackage: LoopOpsSkillPackage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Track your tool history")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text("Status, user, input, cost, duration, output and run links stay visible before any handoff.")
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
            }
            HStack(spacing: 8) {
                Picker("Scope", selection: $toolLogShowsAllActivity) {
                    Text("Selected").tag(false)
                    Text("All activity").tag(true)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                HStack(spacing: 7) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    TextField("Search history", text: $toolLogQuery)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12.5))
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(RadarTheme.panelElevated)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
                )
                Menu {
                    Picker("Status", selection: $toolLogStatusFilter) {
                        ForEach(LoopOpsToolLogStatusFilter.allCases) { filter in
                            Text(filter.rawValue).tag(filter)
                        }
                    }
                } label: {
                    Label(toolLogStatusFilter.rawValue, systemImage: "line.3.horizontal.decrease.circle")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                Menu {
                    Picker("User", selection: $toolLogUserFilter) {
                        ForEach(LoopOpsToolLogUserFilter.allCases) { filter in
                            Text(filter.rawValue).tag(filter)
                        }
                    }
                } label: {
                    Label(toolLogUserFilter.rawValue, systemImage: "person.crop.circle")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
            let logs = filteredToolLogs(for: selectedPackage)
            if logs.isEmpty {
                LoopOpsEmptyText(
                    icon: "clock.arrow.circlepath",
                    title: "No tool history found",
                    detail: "Run a local tool or adjust the history filters."
                )
            } else {
                let visibleLogs = Array(logs.prefix(12))
                VStack(spacing: 0) {
                    LoopOpsToolLogHeaderRow()
                    ForEach(visibleLogs) { log in
                        LoopOpsToolLogRow(
                            log: log,
                            linkedRunTitle: log.runID.flatMap { store.runLedger(runID: $0)?.title },
                            savedToKnowledge: store.knowledgeSources.contains { $0.relatedToolLogIDs?.contains(log.id) == true },
                            saveToKnowledge: { saveToolLogToKnowledge(log) },
                            attachToRun: activeRunLedger.map { ledger in
                                { attachToolLog(log, to: ledger) }
                            },
                            openReviewChat: { openToolLogReviewChat(log) }
                        )
                            .contextMenu {
                                Button("Save to Knowledge") {
                                    saveToolLogToKnowledge(log)
                                }
                                Button("Open Review Chat") {
                                    openToolLogReviewChat(log)
                                }
                                if let ledger = activeRunLedger {
                                    Button(log.runID == ledger.runID ? "Re-attach to selected run" : "Attach to selected run") {
                                        attachToolLog(log, to: ledger)
                                    }
                                }
                            }
                        if log.id != visibleLogs.last?.id {
                            Divider().overlay(RadarTheme.borderSoft)
                        }
                    }
                }
            }
            if let reviewLog = selectedToolReviewLog {
                VStack(alignment: .leading, spacing: 8) {
                    PanelHeader(icon: "bubble.left.and.text.bubble.right", title: "Review Chat", trailing: reviewLog.publicStatusLabel)
                    LoopOpsScopedChatPanel(
                        viewModel: viewModel,
                        store: store,
                        scope: .review,
                        scopeID: reviewLog.reviewChatScopeID,
                        title: "\(reviewLog.publicTitle) review",
                        selectedRun: runState(for: reviewLog.runID),
                        selectedContract: contract(for: reviewLog.runID)
                    )
                }
                .padding(12)
                .radarPanel()
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.skillOSToolLogs)
    }

    private func toolInputBinding(for draft: LoopOpsToolDraft, input: String) -> Binding<String> {
        Binding(
            get: { toolRunInputsByDraftID[draft.id]?[input] ?? "" },
            set: { value in
                var values = toolRunInputsByDraftID[draft.id] ?? [:]
                values[input] = value
                toolRunInputsByDraftID[draft.id] = values
                toolRunValidationByDraftID[draft.id] = draft.missingInputNames(from: values)
            }
        )
    }

    private func buildStepsBinding(for draft: LoopOpsToolDraft) -> Binding<String> {
        Binding(
            get: { toolBuildStepsTextByDraftID[draft.id] ?? draft.visibleSteps.joined(separator: "\n") },
            set: { toolBuildStepsTextByDraftID[draft.id] = $0 }
        )
    }

    private func buildIntegrationBinding(for draft: LoopOpsToolDraft) -> Binding<String> {
        Binding(
            get: { toolBuildIntegrationTextByDraftID[draft.id] ?? draft.resolvedIntegrationSource },
            set: { toolBuildIntegrationTextByDraftID[draft.id] = $0 }
        )
    }

    private func buildInputScopeBinding(for draft: LoopOpsToolDraft) -> Binding<String> {
        Binding(
            get: { toolBuildInputScopeTextByDraftID[draft.id] ?? draft.resolvedInputScope },
            set: { toolBuildInputScopeTextByDraftID[draft.id] = $0 }
        )
    }

    private func buildInputsBinding(for draft: LoopOpsToolDraft) -> Binding<String> {
        Binding(
            get: { toolBuildInputsTextByDraftID[draft.id] ?? draft.inputs.joined(separator: "\n") },
            set: { toolBuildInputsTextByDraftID[draft.id] = $0 }
        )
    }

    private func buildOutputBinding(for draft: LoopOpsToolDraft) -> Binding<String> {
        Binding(
            get: { toolBuildOutputTextByDraftID[draft.id] ?? draft.outputShape },
            set: { toolBuildOutputTextByDraftID[draft.id] = $0 }
        )
    }

    private func buildReviewRuleBinding(for draft: LoopOpsToolDraft) -> Binding<String> {
        Binding(
            get: { toolBuildReviewRuleTextByDraftID[draft.id] ?? draft.reviewPolicy },
            set: { toolBuildReviewRuleTextByDraftID[draft.id] = $0 }
        )
    }

    private func runToolDraft(_ draft: LoopOpsToolDraft) {
        let values = toolRunInputsByDraftID[draft.id] ?? [:]
        let missingInputs = draft.missingInputNames(from: values)
        toolRunValidationByDraftID[draft.id] = missingInputs
        guard missingInputs.isEmpty else {
            _ = store.runLocalToolDraft(
                id: draft.id,
                inputValues: values,
                runID: activeRunLedger?.runID
            )
            selectedToolTab = .logs
            store.showToast(title: "Tool needs input", detail: "\(missingInputs.joined(separator: ", ")) was logged for review.", tone: .warning)
            return
        }

        let runContract = draft.loopContractForRun(inputValues: values, linkedRunID: activeRunLedger?.runID)
        let inputSummary = draft.inputSummary(from: values)
        let instruction = inputSummary == "No inputs provided."
            ? "Run this Skill OS tool from the current workspace context."
            : "Use these provided inputs:\n\(inputSummary)"
        let pendingLog = store.runLocalToolDraft(
            id: draft.id,
            inputValues: values,
            runID: activeRunLedger?.runID
        )
        viewModel.runLoopContract(
            runContract,
            additionalInstruction: instruction,
            parentRunID: activeRunLedger?.runID,
            pendingToolLogIDsByToolID: pendingLog.map { [draft.id: $0.id] } ?? [:],
            loopOpsStore: store
        )
        selectedToolTab = .logs
        store.showToast(title: "Tool run submitted", detail: "\(draft.name) is waiting for run confirmation.", tone: .success)
    }

    private func saveToolDraftBuild(_ draft: LoopOpsToolDraft) {
        let integrationText = toolBuildIntegrationTextByDraftID[draft.id] ?? draft.resolvedIntegrationSource
        let inputScopeText = toolBuildInputScopeTextByDraftID[draft.id] ?? draft.resolvedInputScope
        let inputsText = toolBuildInputsTextByDraftID[draft.id] ?? draft.inputs.joined(separator: "\n")
        let stepsText = toolBuildStepsTextByDraftID[draft.id] ?? draft.visibleSteps.joined(separator: "\n")
        let outputText = toolBuildOutputTextByDraftID[draft.id] ?? draft.outputShape
        let reviewRuleText = toolBuildReviewRuleTextByDraftID[draft.id] ?? draft.reviewPolicy
        let integration = integrationText.trimmingCharacters(in: .whitespacesAndNewlines)
        let inputScope = inputScopeText.trimmingCharacters(in: .whitespacesAndNewlines)
        let inputs = inputsText.linesForLoopOps()
        let steps = stepsText.linesForLoopOps()
        let output = outputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let reviewRule = reviewRuleText.trimmingCharacters(in: .whitespacesAndNewlines)
        var issues: [String] = []
        if integration.isEmpty {
            issues.append("Add a source.")
        }
        if inputScope.isEmpty {
            issues.append("Add input scope.")
        }
        if inputs.isEmpty {
            issues.append("Add at least one required input.")
        }
        if steps.isEmpty {
            issues.append("Add at least one visible step.")
        }
        if output.isEmpty {
            issues.append("Add expected outputs.")
        }
        if reviewRule.isEmpty {
            issues.append("Add review rule.")
        }
        toolBuildValidationByDraftID[draft.id] = issues
        guard issues.isEmpty else {
            return
        }
        guard let updated = store.updateToolDraftBuild(
            id: draft.id,
            integrationSource: integration,
            inputScope: inputScope,
            inputs: inputs,
            visibleSteps: steps,
            outputShape: output,
            reviewPolicy: reviewRule
        ) else {
            return
        }
        toolBuildIntegrationTextByDraftID[updated.id] = updated.resolvedIntegrationSource
        toolBuildInputScopeTextByDraftID[updated.id] = updated.resolvedInputScope
        toolBuildInputsTextByDraftID[updated.id] = updated.inputs.joined(separator: "\n")
        toolBuildStepsTextByDraftID[updated.id] = updated.visibleSteps.joined(separator: "\n")
        toolBuildOutputTextByDraftID[updated.id] = updated.outputShape
        toolBuildReviewRuleTextByDraftID[updated.id] = updated.reviewPolicy
        toolBuildValidationByDraftID[updated.id] = []
        selectedToolTab = .logs
        store.showToast(title: "Draft updated", detail: updated.name, tone: .success)
    }

    private func filteredToolLogs(for package: LoopOpsSkillPackage) -> [LoopOpsToolLog] {
        let trimmed = toolLogQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceLogs = toolLogShowsAllActivity ? store.toolLogs : store.logs(forToolID: package.id)
        return sourceLogs
            .filter { log in
                let matchesStatus = toolLogStatusFilter.accepts(log)
                let matchesUser = toolLogUserFilter.accepts(log)
                let searchableText = [
                    log.publicTitle,
                    log.publicStatusLabel,
                    log.publicSummary,
                    log.publicInputSummary,
                    log.publicOutputOrErrorSummary,
                    log.durationLabel,
                    log.publicReviewState,
                    log.resolvedUserLabel,
                    log.resolvedCostLabel,
                    log.publicSourceLabel,
                    log.runID ?? ""
                ].joined(separator: " ")
                let matchesQuery = trimmed.isEmpty || searchableText.localizedCaseInsensitiveContains(trimmed)
                return matchesStatus && matchesUser && matchesQuery
            }
            .sorted { $0.createdAt > $1.createdAt }
    }

    private func runState(for runID: String?) -> WorkbenchLoopRunState? {
        guard let runID,
              let rawTask = viewModel.agentTasks.first(where: { $0.runID == runID }) else {
            return nil
        }
        let task = viewModel.loopOpsTaskApplyingLifecycleOverride(rawTask)
        let loop = viewModel.agentCapabilityLoopByRunID[task.runID]
        return WorkbenchLoopRunState(
            task: task,
            domain: WorkbenchBlockClassifier.domain(for: task, capabilityLoop: loop),
            capabilityLoop: loop,
            finalReadModel: viewModel.agentFinalReadModelByRunID[task.runID]
        )
    }

    private func contract(for runID: String?) -> LoopContract? {
        guard let runID,
              let ledger = store.runLedger(runID: runID) else {
            return nil
        }
        return store.contract(for: ledger)
    }

    private func saveToolLogToKnowledge(_ log: LoopOpsToolLog) {
        let source = store.materializeKnowledgeSource(
            id: "tool-log-\(log.id)",
            title: log.publicTitle,
            kind: .log,
            summary: log.publicOutputOrErrorSummary,
            sourceLabel: "Tool Log",
            linkedRunIDs: log.runID.map { [$0] },
            bodyMarkdown: """
            # \(log.publicTitle)

            \(log.publicSummary)

            Source: \(log.publicSourceLabel)
            Linked run: \(log.runID ?? "Not linked")
            Status: \(log.publicStatusLabel)
            Review state: \(log.publicReviewState)
            User: \(log.resolvedUserLabel)
            Cost: \(log.resolvedCostLabel)

            ## Input
            \(log.publicInputSummary)

            ## Output
            \(log.publicOutputOrErrorSummary)
            """,
            tags: ["Tool Log", log.publicStatusLabel],
            relatedToolLogIDs: [log.id]
        )
        store.showToast(title: "Saved to Knowledge", detail: "\(source.title) 已加入 Knowledge。", tone: .success)
    }

    private func attachToolLog(_ log: LoopOpsToolLog, to ledger: RunLedgerRow) {
        let linkedLog = store.updateToolLogRunLink(logID: log.id, runID: ledger.runID) ?? log
        let source = store.materializeKnowledgeSource(
            id: "tool-log-\(linkedLog.id)",
            title: linkedLog.publicTitle,
            kind: .log,
            summary: linkedLog.publicOutputOrErrorSummary,
            sourceLabel: "Tool Log",
            linkedRunIDs: [ledger.runID],
            bodyMarkdown: """
            # \(linkedLog.publicTitle)

            Attached to: \(ledger.title)
            Source: \(linkedLog.publicSourceLabel)
            Status: \(linkedLog.publicStatusLabel)
            User: \(linkedLog.resolvedUserLabel)
            Cost: \(linkedLog.resolvedCostLabel)

            ## Input
            \(linkedLog.publicInputSummary)

            ## Output
            \(linkedLog.publicOutputOrErrorSummary)
            """,
            tags: ["Tool Log", linkedLog.publicStatusLabel],
            relatedToolLogIDs: [linkedLog.id]
        )
        _ = store.attachKnowledgeSource(id: source.id, toRunID: ledger.runID, runTitle: ledger.title)
    }

    private func openToolLogReviewChat(_ log: LoopOpsToolLog) {
        selectedToolReviewLogID = log.id
        let linkedRunTitle = log.runID.flatMap { store.runLedger(runID: $0)?.title } ?? "No linked run"
        store.appendMessage(
            scope: .review,
            scopeID: log.reviewChatScopeID,
            title: "\(log.publicTitle) review",
            role: .assistant,
            text: """
            Review context for \(log.publicTitle).

            Status: \(log.publicStatusLabel)
            Review state: \(log.publicReviewState)
            Linked run: \(linkedRunTitle)
            User: \(log.resolvedUserLabel)
            Cost: \(log.resolvedCostLabel)

            Input:
            \(log.publicInputSummary)

            Output or error:
            \(log.publicOutputOrErrorSummary)

            Review-only boundary: explain the issue, list evidence gaps, or propose next checks. Do not publish, send, trade, or mutate external systems.
            """
        )
        store.showToast(title: "Review Chat opened", detail: "\(log.publicTitle) is ready for review.", tone: .info)
    }

    private var createToolSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                PanelHeader(icon: "plus.rectangle.on.folder", title: "Choose a starting point", trailing: selectedStartingPoint.title)
                Spacer()
                Button("Cancel") { createToolPresented = false }
                    .buttonStyle(ResearchSecondaryButtonStyle())
            }
            Picker("Mode", selection: $createToolMode) {
                ForEach(LoopOpsToolStartingPoint.all) { point in
                    Text(point.title).tag(point.id)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: createToolMode) { _, newValue in
                applyStartingPoint(newValue, replacePrompt: true)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
                ForEach(LoopOpsToolStartingPoint.all) { point in
                    Button {
                        applyStartingPoint(point.id, replacePrompt: true)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(point.title)
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                            Text(point.summary)
                                .font(.system(size: 11))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .lineLimit(4)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, minHeight: 94, alignment: .topLeading)
                        .padding(10)
                        .background(createToolMode == point.id ? RadarTheme.blue.opacity(0.12) : RadarTheme.panelElevated)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .strokeBorder(createToolMode == point.id ? RadarTheme.blue.opacity(0.44) : RadarTheme.borderSoft, lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(point.interactionID)
                }
            }
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Tool name")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                    TextField("Tool name", text: $createToolName)
                        .loopOpsField()
                        .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateToolName)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Source")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                    TextField("Local Tool, integration, or imported source", text: $createToolIntegration)
                        .loopOpsField()
                        .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateToolIntegration)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Input context")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                    Picker("Input context", selection: $createToolInputScope) {
                        ForEach(LoopOpsToolStartingPoint.inputScopes, id: \.self) { scope in
                            Text(scope).tag(scope)
                        }
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(RadarTheme.panelElevated)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
                    )
                    .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateToolInputScope)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Task description")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                TextField("Describe the tool...", text: $createToolPrompt, axis: .vertical)
                    .lineLimit(5...8)
                    .loopOpsField()
                    .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateToolDescription)
            }
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Visible steps")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                    TextField("One step per line", text: $createToolStepsText, axis: .vertical)
                        .lineLimit(4...7)
                        .loopOpsField()
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Outputs")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.secondaryText)
                    TextField("Output shape", text: $createToolOutput, axis: .vertical)
                        .lineLimit(4...7)
                        .loopOpsField()
                        .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateToolOutput)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Review rule")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.secondaryText)
                TextField("Review boundary and confirmation rule", text: $createToolReviewRule, axis: .vertical)
                    .lineLimit(2...5)
                    .loopOpsField()
                    .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateToolReviewRule)
            }
            if !createToolValidationIssues.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Validation")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(RadarTheme.gold)
                    ForEach(createToolValidationIssues, id: \.self) { issue in
                        Text(issue)
                            .font(.system(size: 11.5))
                            .foregroundStyle(RadarTheme.secondaryText)
                    }
                }
                .padding(10)
                .background(RadarTheme.gold.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            HStack(spacing: 8) {
                Button("Start") {
                    createToolDraft()
                }
                .buttonStyle(ResearchPrimaryButtonStyle())
                .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateToolStart)
                Button("Start from blank") {
                    applyStartingPoint("Default", replacePrompt: true)
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .accessibilityIdentifier(LoopOpsInteractionID.skillOSCreateToolScratch)
            }
        }
        .padding(18)
        .frame(width: 640)
    }

    private func applyStartingPoint(_ id: String, replacePrompt: Bool) {
        let point = LoopOpsToolStartingPoint.selected(id)
        createToolMode = point.id
        createToolName = point.draftName
        createToolIntegration = point.id == "Import" ? "Imported definition" : "Local Tool"
        createToolInputScope = point.inputScope
        createToolStepsText = point.visibleSteps.joined(separator: "\n")
        createToolOutput = point.outputShape
        createToolReviewRule = point.reviewPolicy
        createToolValidationIssues = []
        if replacePrompt {
            createToolPrompt = point.prompt
        }
    }

    private func toggle(_ package: LoopOpsSkillPackage) {
        if let draft = localToolDraft(for: package) {
            let nextEnabled = !draft.isEnabled
            _ = store.setToolDraftEnabled(id: draft.id, enabled: nextEnabled)
            if nextEnabled {
                viewModel.selectedLoopOpsToolDraftIDs.insert(draft.id)
            } else {
                viewModel.selectedLoopOpsToolDraftIDs.remove(draft.id)
            }
            let newStatus = nextEnabled ? "Enabled" : "Disabled"
            store.appendToolLog(
                LoopOpsToolLog(
                    toolID: draft.id,
                    title: "\(draft.name) \(newStatus.lowercased())",
                    status: newStatus,
                    summary: "Local Tool selection saved in Skill OS.",
                    durationLabel: "instant",
                    reviewState: "No external action",
                    source: "Local Tool",
                    userLabel: "You",
                    costLabel: "0 credits"
                )
            )
            store.showToast(title: "Tool \(newStatus.lowercased())", detail: draft.name, tone: .info)
        } else {
            switch package.kind {
            case .skill:
                viewModel.toggleAgentSkill(package.id)
            case .extensionPackage:
                viewModel.toggleAgentExtension(package.id)
            }
            let newStatus = package.selected ? "Disabled" : "Enabled"
            store.appendToolLog(
                LoopOpsToolLog(
                    toolID: package.id,
                    title: "\(package.title) \(newStatus.lowercased())",
                    status: newStatus,
                    summary: "Selection changed from Skill OS.",
                    durationLabel: "instant",
                    reviewState: "No external action",
                    source: "Skill OS",
                    userLabel: "You",
                    costLabel: "0 credits"
                )
            )
            store.showToast(title: "Tool \(newStatus.lowercased())", detail: package.title, tone: .info)
        }
    }

    private func toggleColumn(_ column: LoopOpsToolColumn) {
        if visibleToolColumns.contains(column) {
            visibleToolColumns.remove(column)
        } else {
            visibleToolColumns.insert(column)
        }
        if visibleToolColumns.isEmpty {
            visibleToolColumns.insert(.name)
        }
    }

    private func apply(_ stack: LoopOpsSkillStack) {
        for binding in stack.bindings {
            enable(binding)
        }
    }

    private func applyActiveStackToSelection() {
        for binding in activeStackBindingsForDisplay {
            enable(binding)
        }
        store.showToast(
            title: "Stack enabled",
            detail: "\(activeStackBindingsForDisplay.count) tool(s) are now active for Loop runs.",
            tone: .success
        )
    }

    private func enable(_ binding: LoopOpsSkillBinding) {
        guard binding.enabled else { return }
        switch binding.kind {
        case .skill:
            if store.toolDrafts.contains(where: { $0.id == binding.id }) {
                _ = store.setToolDraftEnabled(id: binding.id, enabled: true)
                viewModel.selectedLoopOpsToolDraftIDs.insert(binding.id)
            } else if !viewModel.selectedAgentSkillIDs.contains(binding.id) {
                viewModel.selectedAgentSkillIDs.insert(binding.id)
            }
        case .extensionPackage:
            if !viewModel.selectedAgentExtensionIDs.contains(binding.id) {
                viewModel.selectedAgentExtensionIDs.insert(binding.id)
            }
        }
    }

    private func loadInitialActiveStack() {
        guard activeStackBindings.isEmpty else { return }
        if let stack = store.allSkillStacksForDisplay.first {
            load(stack)
        } else {
            activeStackBindings = selectedBindings
        }
    }

    private func load(_ stack: LoopOpsSkillStack) {
        activeStackID = stack.id
        stackName = stack.name
        activeStackBindings = stack.bindings
    }

    private func addToActiveStack(_ package: LoopOpsSkillPackage) {
        activeStackBindings = LoopOpsSkillPathDropResolver.insert(
            package.binding(order: activeStackBindingsForDisplay.count, source: "skill-os-stack"),
            before: nil,
            into: activeStackBindingsForDisplay
        )
    }

    private func applyActiveStackDrop(_ payload: String, before beforeID: String?) {
        activeStackBindings = LoopOpsSkillPathDropResolver.apply(
            payload: payload,
            before: beforeID,
            to: activeStackBindings,
            stacks: store.allSkillStacksForDisplay
        )
    }

    private func saveActiveStack() {
        let bindings = activeStackBindingsForDisplay
        let name = stackName.trimmingCharacters(in: .whitespacesAndNewlines)
        let stack = LoopOpsSkillStack(
            id: activeStackID ?? "skill-stack-\(UUID().uuidString)",
            name: name.isEmpty ? "Untitled Skill Stack" : name,
            summary: bindings.map(\.title).joined(separator: " -> "),
            bindings: bindings,
            createdAt: selectedActiveStack?.createdAt ?? Date()
        )
        store.upsertSkillStack(stack)
        activeStackID = stack.id
        activeStackBindings = stack.bindings
        store.showToast(title: "Stack saved", detail: "\(stack.name) 已加入 Skill Stacks。", tone: .success)
    }

    private func saveSelectedStack() {
        activeStackBindings = selectedBindings
        saveActiveStack()
    }

    private func createToolDraft() {
        let startingPoint = selectedStartingPoint
        let trimmed = createToolPrompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedName = createToolName.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = trimmedName.isEmpty ? startingPoint.draftName : trimmedName
        let resolvedIntegration = createToolIntegration.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedInputScope = createToolInputScope.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? startingPoint.inputScope
            : createToolInputScope
        let resolvedOutput = createToolOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedReviewRule = createToolReviewRule.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedSteps = createToolStepsText.linesForLoopOps()
        createToolValidationIssues = validateToolDraftContract(
            name: title,
            integration: resolvedIntegration,
            purpose: trimmed,
            steps: resolvedSteps,
            output: resolvedOutput,
            reviewRule: resolvedReviewRule
        )
        guard createToolValidationIssues.isEmpty else {
            store.appendToolLog(
                LoopOpsToolLog(
                    toolID: "tool-validation-\(title.normalizedLoopOpsViewToken)",
                    title: "\(title) validation",
                    status: "Needs review",
                    summary: createToolValidationIssues.joined(separator: "\n"),
                    durationLabel: "instant",
                    reviewState: "Fix required",
                    source: resolvedIntegration.isEmpty ? "Missing source" : resolvedIntegration,
                    userLabel: "You",
                    costLabel: "0 credits"
                )
            )
            store.showToast(title: "Tool needs fields", detail: createToolValidationIssues.first ?? "Review highlighted fields.", tone: .warning)
            return
        }
        let draft = LoopOpsToolDraft(
            name: title,
            purpose: trimmed.isEmpty ? startingPoint.purpose : trimmed,
            enabled: true,
            integrationSource: resolvedIntegration,
            inputScope: resolvedInputScope,
            inputs: LoopOpsToolStartingPoint.inputs(for: resolvedInputScope, fallback: startingPoint.inputs),
            visibleSteps: resolvedSteps.isEmpty ? startingPoint.visibleSteps : resolvedSteps,
            outputShape: resolvedOutput,
            reviewPolicy: resolvedReviewRule,
            skillBindings: selectedBindings
        )
        store.upsertToolDraft(draft)
        viewModel.selectedLoopOpsToolDraftIDs.insert(draft.id)
        store.appendToolLog(
            LoopOpsToolLog(
                toolID: draft.id,
                title: "\(draft.name) validated",
                status: "Validated",
                summary: "\(startingPoint.summary)\nStarting point: \(startingPoint.title)\nSource: \(resolvedIntegration)\nInput context: \(resolvedInputScope)\nOutputs: \(resolvedOutput)",
                durationLabel: "created now",
                reviewState: "Review-only",
                source: resolvedIntegration,
                userLabel: "You",
                costLabel: "0 credits"
            )
        )
        selectedPackageID = draft.id
        selectedToolTab = .logs
        store.showToast(title: "Tool draft created", detail: "\(draft.name) 已保存。", tone: .success)
        createToolPresented = false
    }

    private func localToolDraft(for package: LoopOpsSkillPackage) -> LoopOpsToolDraft? {
        store.toolDrafts.first { $0.id == package.id }
    }

    private func deleteLocalToolDraft(_ draft: LoopOpsToolDraft) {
        viewModel.selectedLoopOpsToolDraftIDs.remove(draft.id)
        store.deleteToolDraft(id: draft.id)
        store.appendToolLog(
            LoopOpsToolLog(
                toolID: draft.id,
                title: "\(draft.name) deleted",
                status: "Deleted",
                summary: "Local Tool removed from Skill OS. Existing run results remain unchanged.",
                durationLabel: "instant",
                reviewState: "No external action",
                source: "Local Tool",
                userLabel: "You",
                costLabel: "0 credits"
            )
        )
        if selectedPackageID == draft.id {
            selectedPackageID = packages.first?.id
        }
        store.showToast(title: "Tool deleted", detail: draft.name, tone: .warning)
    }

    private func validateToolDraftContract(
        name: String,
        integration: String,
        purpose: String,
        steps: [String],
        output: String,
        reviewRule: String
    ) -> [String] {
        var issues: [String] = []
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("Add a tool name.")
        }
        if integration.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("Add a source or integration label.")
        }
        if purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("Describe the task this tool performs.")
        }
        if steps.isEmpty {
            issues.append("Add at least one visible step.")
        }
        if output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("Define the output shape.")
        }
        if reviewRule.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("Define the review rule.")
        }
        return issues
    }
}

struct LoopOpsWorkforceView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var store: LoopOpsLocalStore
    let metrics: WorkbenchLayoutMetrics

    @State private var query = ""
    @State private var selectedStackID: String?

    private var stacks: [LoopOpsSkillStack] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = store.allSkillStacksForDisplay
        guard !trimmed.isEmpty else { return base }
        return base.filter {
            "\($0.name) \($0.summary) \($0.bindings.map(\.title).joined(separator: " "))"
                .localizedCaseInsensitiveContains(trimmed)
        }
    }

    private var selectedStack: LoopOpsSkillStack? {
        if let selectedStackID {
            return stacks.first { $0.id == selectedStackID } ?? store.allSkillStacksForDisplay.first { $0.id == selectedStackID }
        }
        return stacks.first
    }

    private var selectedSkillBindings: [LoopOpsSkillBinding] {
        LoopOpsSkillPackage.packages(from: viewModel, toolDrafts: store.toolDrafts)
            .filter(\.selected)
            .enumerated()
            .map { index, package in package.binding(order: index, source: "workforce-selection") }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LoopOpsPageHeader(
                title: "Agent Team",
                subtitle: "Reusable multi-skill teams and loop-ready execution stacks.",
                icon: "person.3.sequence",
                trailing: "\(stacks.count) stacks"
            )

            if metrics.isCompact {
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    workforceList
                    workforceDetail
                }
            } else {
                HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                    workforceList
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    workforceDetail
                        .frame(width: metrics.supportColumnWidth)
                }
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.buildWorkforceList)
    }

    private var workforceList: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "person.3.sequence", title: "Your agent teams", trailing: "\(stacks.count)")
            HStack(spacing: 8) {
                TextField("Search agent teams...", text: $query)
                    .loopOpsField()
                Button {
                    saveCurrentSelectionAsStack()
                } label: {
                    Label("New Stack", systemImage: "plus")
                }
                .buttonStyle(ResearchPrimaryButtonStyle())
                .disabled(selectedSkillBindings.isEmpty)
            }

            if stacks.isEmpty {
                LoopOpsEmptyText(icon: "person.3.sequence", title: "No agent teams", detail: "Select tools in Skill OS, then save them as a reusable team.")
            } else {
                VStack(spacing: 0) {
                    LoopOpsResourceTableHeader(columns: ["Agent Team", "Skills", "Updated"])
                    ForEach(stacks) { stack in
                        Button {
                            selectedStackID = stack.id
                        } label: {
                            LoopOpsWorkforceRow(stack: stack, selected: selectedStack?.id == stack.id)
                        }
                        .buttonStyle(.plain)
                        .onDrag { NSItemProvider(object: "loopops-stack|\(stack.id)" as NSString) }
                        Divider().overlay(RadarTheme.borderSoft)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
                )
            }
        }
        .padding(14)
        .radarPanel()
    }

    private var workforceDetail: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(icon: "doc.text.magnifyingglass", title: "Agent Team Page", trailing: selectedStack.map { "\($0.bindings.count) tools" } ?? "select")
            if let selectedStack {
                LoopOpsKeyValue(label: "Name", value: selectedStack.name)
                LoopOpsKeyValue(label: "Summary", value: selectedStack.summary)
                LoopOpsSkillPathList(bindings: selectedStack.bindings, title: "Skill stack")
                HStack(spacing: 8) {
                    Button {
                        apply(selectedStack)
                    } label: {
                        Label("Enable stack", systemImage: "checkmark.circle")
                    }
                    .buttonStyle(ResearchPrimaryButtonStyle())
                    Button {
                        delete(selectedStack)
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .disabled(store.starterSkillStacks.map(\.id).contains(selectedStack.id))
                }
            } else {
                LoopOpsEmptyText(icon: "person.3.sequence", title: "Select an agent team", detail: "Pick a stack to inspect the ordered skill team.")
            }
        }
        .padding(14)
        .radarPanel()
    }

    private func saveCurrentSelectionAsStack() {
        let stack = LoopOpsSkillStack(
            name: "Selected Tool Stack",
            summary: selectedSkillBindings.map(\.title).joined(separator: " -> "),
            bindings: selectedSkillBindings
        )
        store.upsertSkillStack(stack)
        selectedStackID = stack.id
    }

    private func apply(_ stack: LoopOpsSkillStack) {
        for binding in stack.bindings {
            switch binding.kind {
            case .skill:
                viewModel.selectedAgentSkillIDs.insert(binding.id)
            case .extensionPackage:
                viewModel.selectedAgentExtensionIDs.insert(binding.id)
            }
        }
    }

    private func delete(_ stack: LoopOpsSkillStack) {
        guard !store.starterSkillStacks.map(\.id).contains(stack.id) else { return }
        store.deleteSkillStack(id: stack.id)
        selectedStackID = stacks.first?.id
    }
}

struct LoopOpsKnowledgeView: View {
    @ObservedObject var store: LoopOpsLocalStore
    let metrics: WorkbenchLayoutMetrics

    @State private var query = ""
    @State private var statusFilter: LoopOpsKnowledgeStatusFilter = .all
    @State private var selectedID: String?
    @State private var knowledgeDraftSourceID: String?
    @State private var knowledgeDraftTitle = ""
    @State private var knowledgeDraftSummary = ""
    @State private var knowledgeDraftSourceLabel = ""
    @State private var knowledgeDraftBody = ""
    @State private var knowledgeDraftTags = ""
    @State private var knowledgeDraftURL = ""
    @State private var knowledgeDraftStatus: LoopOpsKnowledgeSourceStatus = .draft
    @State private var knowledgeDraftReuseMode: LoopOpsKnowledgeReuseMode = .manual
    @State private var attachTargetSheetPresented = false

    private var rows: [LoopOpsKnowledgeRowModel] {
        let sourceRows: [LoopOpsKnowledgeRowModel] = store.knowledgeSources
            .filter { statusFilter.accepts($0.status) }
            .map { source in
            let linkedCount = (source.linkedRunIDs ?? []).count
                + (source.relatedReviewPacketIDs ?? []).count
                + (source.relatedChatThreadIDs ?? []).count
                + (source.relatedToolLogIDs ?? []).count
            return LoopOpsKnowledgeRowModel(
                id: source.id,
                title: source.title,
                kind: source.kind.title,
                sourceKind: source.kind,
                summary: source.summary,
                detail: "\(source.lifecycleSummary) · \(source.reuseMode.title) · \(linkedCount) links",
                documentLabel: loopOpsKnowledgeCount(source.visibleDocumentCount, singular: "document", plural: "documents"),
                linkedLabel: loopOpsKnowledgeCount(linkedCount, singular: "link", plural: "links"),
                updatedLabel: loopOpsKnowledgeDateLabel(source.updatedAt),
                statusLabel: source.status.title,
                ownerLabel: "Workspace",
                updatedAt: source.updatedAt,
                progressLabel: "\(Int((source.normalizedImportProgress * 100).rounded()))%",
                errorSummary: source.errorSummary,
                retryCount: source.retryCount ?? 0,
                lastSyncedLabel: loopOpsKnowledgeDateLabel(source.lastSyncedAt),
                canAttach: source.canAttachToRun
            )
        }
        let allRows = sourceRows.sorted { lhs, rhs in
            switch (lhs.updatedAt, rhs.updatedAt) {
            case let (left?, right?):
                return left > right
            case (.some, .none):
                return true
            case (.none, .some):
                return false
            case (.none, .none):
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
        }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return allRows }
        return allRows.filter {
            "\($0.title) \($0.kind) \($0.summary) \($0.detail)"
                .localizedCaseInsensitiveContains(trimmed)
        }
    }

    private var starterModels: [LoopOpsKnowledgeStarterModel] {
        [
            LoopOpsKnowledgeStarterModel(kind: .blank, title: "Blank", summary: "Start a reusable note or source page.", icon: LoopOpsKnowledgeSourceKind.blank.systemImage),
            LoopOpsKnowledgeStarterModel(kind: .upload, title: "Upload file", summary: "Create a source placeholder for a local document.", icon: LoopOpsKnowledgeSourceKind.upload.systemImage),
            LoopOpsKnowledgeStarterModel(kind: .website, title: "Import website", summary: "Track a URL as a reviewable knowledge source.", icon: LoopOpsKnowledgeSourceKind.website.systemImage),
            LoopOpsKnowledgeStarterModel(kind: .integration, title: "Integration", summary: "Reserve a connected source for a workspace system.", icon: LoopOpsKnowledgeSourceKind.integration.systemImage)
        ]
    }

    private var selectedRow: LoopOpsKnowledgeRowModel? {
        if let selectedID {
            return rows.first { $0.id == selectedID }
        }
        return rows.first
    }

    private var selectedSource: LoopOpsKnowledgeSource? {
        guard let selectedRow else { return nil }
        return store.knowledgeSources.first { $0.id == selectedRow.id }
    }

    private var selectedReviewPacket: ReviewPacketViewModel? {
        guard let id = selectedRow?.relatedReviewPacketID else { return nil }
        return store.reviewPackets.first { $0.id == id }
    }

    private var selectedChatThread: ChatThread? {
        guard let id = selectedRow?.relatedChatThreadID else { return nil }
        return store.chatThreads.first { $0.id == id }
    }

    private var selectedToolLog: LoopOpsToolLog? {
        guard let id = selectedRow?.relatedToolLogID else { return nil }
        return store.toolLogs.first { $0.id == id }
    }

    private var latestRunLedger: RunLedgerRow? {
        store.runLedgers.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LoopOpsPageHeader(
                title: "Knowledge",
                subtitle: "Reusable source pages for loops, reviews, conversations and evidence captures.",
                icon: "tray.full",
                trailing: "\(rows.count) sources"
            )

            if metrics.isCompact {
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    knowledgeList
                    knowledgeDetail
                }
            } else {
                HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                    knowledgeList
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    knowledgeDetail
                        .frame(width: metrics.supportColumnWidth)
                }
            }
        }
        .onAppear(perform: syncKnowledgeSelection)
        .onChange(of: selectedID) { _, _ in syncKnowledgeDraft() }
        .onChange(of: store.knowledgeSources) { _, _ in syncKnowledgeDraftIfNeeded() }
        .sheet(isPresented: $attachTargetSheetPresented) {
            knowledgeAttachSheet
                .frame(minWidth: 520, minHeight: 460)
        }
        .accessibilityIdentifier(LoopOpsInteractionID.buildKnowledgeList)
    }

    private var knowledgeList: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                PanelHeader(icon: "tray.full", title: "Knowledge base", trailing: "\(rows.count)")
                Spacer()
                Menu {
                    Button {
                        createKnowledge(.blank)
                    } label: {
                        Label("Blank", systemImage: LoopOpsKnowledgeSourceKind.blank.systemImage)
                    }
                    Button {
                        createKnowledge(.upload)
                    } label: {
                        Label("Upload file", systemImage: LoopOpsKnowledgeSourceKind.upload.systemImage)
                    }
                    Button {
                        createKnowledge(.website)
                    } label: {
                        Label("Import from website", systemImage: LoopOpsKnowledgeSourceKind.website.systemImage)
                    }
                    Button {
                        createKnowledge(.integration)
                    } label: {
                        Label("Integrations", systemImage: LoopOpsKnowledgeSourceKind.integration.systemImage)
                    }
                } label: {
                    Label("New Knowledge", systemImage: "plus")
                }
                .buttonStyle(ResearchPrimaryButtonStyle())
                .accessibilityIdentifier(LoopOpsInteractionID.knowledgeNewMenu)
            }
            LoopOpsManagementHero(
                title: "Your knowledge base",
                subtitle: "Sources stay as reusable pages. Review packets, chats and tool results are saved here only when you explicitly create a source.",
                icon: "link.badge.plus",
                segments: ["Upload", "Run", "Review", "Blank"]
            )
            FlowLayout(spacing: 8) {
                ForEach(starterModels) { starter in
                    Button {
                        createKnowledge(starter.kind)
                    } label: {
                        LoopOpsKnowledgeStarterButton(starter: starter)
                    }
                    .buttonStyle(.plain)
                }
            }
            .accessibilityIdentifier("loopops.knowledge.starters")

            HStack(spacing: 8) {
                TextField("Search sources...", text: $query)
                    .loopOpsField()
                Menu {
                    ForEach(LoopOpsKnowledgeStatusFilter.allCases) { filter in
                        Button(filter.title) { statusFilter = filter }
                    }
                } label: {
                    Label(statusFilter.title, systemImage: "line.3.horizontal.decrease.circle")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .accessibilityIdentifier("loopops.knowledge.status-filter")
            }

            if rows.isEmpty {
                LoopOpsEmptyText(icon: "tray", title: "No matching sources", detail: "Create a source page or adjust the status filter.")
            } else {
                VStack(spacing: 0) {
                    LoopOpsResourceTableHeader(columns: ["Name", "Source type", "Documents", "Linked", "Updated", "Status"])
                    ForEach(rows) { row in
                        Button {
                            selectedID = row.id
                        } label: {
                            LoopOpsKnowledgeRow(row: row, selected: selectedRow?.id == row.id)
                        }
                        .buttonStyle(.plain)
                        Divider().overlay(RadarTheme.borderSoft)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
                )
            }
        }
        .padding(14)
        .radarPanel()
    }

    private var knowledgeDetail: some View {
        VStack(alignment: .leading, spacing: 12) {
            PanelHeader(icon: "doc.text.magnifyingglass", title: "Knowledge Page", trailing: selectedRow?.kind ?? "select")
            if let selectedRow {
                if selectedSource != nil {
                    knowledgeSourceEditor(selectedRow)
                } else {
                    knowledgeArtifactPage(selectedRow)
                    Button {
                        materializeSelectedRow(selectedRow)
                    } label: {
                        Label("Save as source", systemImage: "tray.and.arrow.down")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                }
                LoopOpsEmptyText(icon: "lock.shield", title: "Reuse boundary", detail: "Knowledge can inform a run, but external sending and live actions still require explicit review.")
                Button {
                    attachTargetSheetPresented = true
                } label: {
                    Label("Attach to run...", systemImage: "paperclip")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .disabled(store.runLedgers.isEmpty || selectedRow.canAttach == false)
                .accessibilityIdentifier(LoopOpsInteractionID.knowledgeAttachLatestRun)
                if selectedRow.canAttach == false {
                    LoopOpsInlineNotice(
                        icon: "exclamationmark.triangle",
                        title: "Needs review",
                        detail: "Mark this source ready before attaching it to a run."
                    )
                }
            } else {
                LoopOpsEmptyText(icon: "tray.full", title: "Select a source", detail: "Pick a row to inspect its review-safe context.")
            }
        }
        .padding(14)
        .radarPanel()
    }

    @ViewBuilder
    private func knowledgeArtifactPage(_ row: LoopOpsKnowledgeRowModel) -> some View {
        knowledgeRowMetadata(row)
        if let packet = selectedReviewPacket {
            LoopOpsKeyValue(label: "Name", value: row.title)
            LoopOpsKeyValue(label: "Type", value: row.kind)
            LoopOpsKeyValue(label: "Decision", value: loopOpsReviewDecisionDisplay(packet.reviewDecision))
            LoopOpsKeyValue(label: "Final answer", value: packet.finalAnswer)
            LoopOpsKeyValue(label: "Claims", value: packet.claims.isEmpty ? "No claims recorded." : packet.claims.joined(separator: "\n"))
            LoopOpsKeyValue(label: "Evidence gaps", value: packet.evidenceGaps.isEmpty ? "No evidence gaps recorded." : packet.evidenceGaps.joined(separator: "\n"))
            LoopOpsKeyValue(label: "Blocked actions", value: packet.blockedActions.isEmpty ? "No blocked actions recorded." : packet.blockedActions.joined(separator: "\n"))
            LoopOpsKeyValue(label: "Next questions", value: packet.nextQuestions.isEmpty ? "No follow-up questions recorded." : packet.nextQuestions.joined(separator: "\n"))
        } else if let thread = selectedChatThread {
            LoopOpsKeyValue(label: "Name", value: row.title)
            LoopOpsKeyValue(label: "Type", value: row.kind)
            LoopOpsKeyValue(label: "Messages", value: "\(thread.messages.count)")
            ForEach(thread.messages.suffix(6)) { message in
                LoopOpsKeyValue(label: message.role.rawValue.capitalized, value: message.text)
            }
        } else if let log = selectedToolLog {
            LoopOpsKeyValue(label: "Name", value: row.title)
            LoopOpsKeyValue(label: "Type", value: row.kind)
            LoopOpsKeyValue(label: "Source", value: log.publicSourceLabel)
            LoopOpsKeyValue(label: "Linked run", value: log.runID ?? "Not linked")
            LoopOpsKeyValue(label: "Status", value: "\(log.status) · \(log.publicReviewState)")
            LoopOpsKeyValue(label: "Input", value: log.publicInputSummary)
            LoopOpsKeyValue(label: "Output", value: log.publicOutputOrErrorSummary)
        } else {
            LoopOpsKeyValue(label: "Name", value: row.title)
            LoopOpsKeyValue(label: "Type", value: row.kind)
            LoopOpsKeyValue(label: "Summary", value: row.summary)
            LoopOpsKeyValue(label: "Status", value: row.detail)
        }
    }

    private func knowledgeRowMetadata(_ row: LoopOpsKnowledgeRowModel) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Collection fields")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            FlowLayout(spacing: 6) {
                LoopOpsPill(text: row.kind, color: RadarTheme.blue, icon: row.sourceKind.systemImage)
                LoopOpsPill(text: row.documentLabel, color: RadarTheme.secondaryText, icon: "doc.text")
                LoopOpsPill(text: row.linkedLabel, color: RadarTheme.green, icon: "link")
                LoopOpsPill(text: row.updatedLabel, color: RadarTheme.secondaryText, icon: "clock")
                LoopOpsPill(text: row.statusLabel, color: RadarTheme.gold, icon: "checkmark.seal")
                LoopOpsPill(text: row.ownerLabel, color: RadarTheme.secondaryText, icon: "person.crop.circle")
            }
        }
    }

    private func knowledgeSourceEditor(_ row: LoopOpsKnowledgeRowModel) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Source name", text: $knowledgeDraftTitle)
                .loopOpsField()
            TextField("Summary", text: $knowledgeDraftSummary, axis: .vertical)
                .lineLimit(3...6)
                .loopOpsField()
            TextField("Source label", text: $knowledgeDraftSourceLabel)
                .loopOpsField()
            TextField("Source URL or local reference", text: $knowledgeDraftURL)
                .loopOpsField()
            if let source = selectedSource {
                knowledgeSourceSetupState(source)
            }
            TextField("Tags, comma separated", text: $knowledgeDraftTags)
                .loopOpsField()
            TextField("Page body", text: $knowledgeDraftBody, axis: .vertical)
                .lineLimit(8...14)
                .loopOpsField()
            Picker("Status", selection: $knowledgeDraftStatus) {
                ForEach(LoopOpsKnowledgeSourceStatus.allCases) { status in
                    Text(status.title).tag(status)
                }
            }
            .pickerStyle(.segmented)
            Picker("Reuse", selection: $knowledgeDraftReuseMode) {
                ForEach(LoopOpsKnowledgeReuseMode.allCases) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            if let source = selectedSource, let activity = source.activity, !activity.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Activity")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    ForEach(activity.suffix(3), id: \.self) { item in
                        Text(item)
                            .font(.system(size: 11))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(1)
                    }
                }
            }
            if let source = selectedSource {
                knowledgeRelations(source)
            }
            HStack(spacing: 8) {
                Button {
                    saveKnowledgeDraft()
                } label: {
                    Label("Save source", systemImage: "tray.and.arrow.down")
                }
                .buttonStyle(ResearchPrimaryButtonStyle())
                if let source = selectedSource {
                    Button {
                        startKnowledgeSetup(source)
                    } label: {
                        Label(source.status == .draft ? "Start setup" : "Retry sync", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .disabled(source.status == .ready || source.status == .syncing)
                    Button {
                        completeKnowledgeSetup(source)
                    } label: {
                        Label("Mark ready", systemImage: "checkmark.circle")
                    }
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .disabled(source.status == .ready)
                }
                Button {
                    syncKnowledgeDraft(force: true)
                } label: {
                    Label("Reset", systemImage: "arrow.counterclockwise")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
            .accessibilityIdentifier("loopops.knowledge.source-editor")
        }
    }

    private func knowledgeSourceSetupState(_ source: LoopOpsKnowledgeSource) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text("Setup state")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                Spacer()
                LoopOpsPill(text: source.lifecycleSummary, color: source.canAttachToRun ? RadarTheme.green : RadarTheme.gold, icon: source.canAttachToRun ? "checkmark.circle" : "clock")
            }
            ProgressView(value: source.normalizedImportProgress)
                .tint(source.canAttachToRun ? RadarTheme.green : RadarTheme.blue)
            FlowLayout(spacing: 6) {
                LoopOpsPill(text: "\(Int((source.normalizedImportProgress * 100).rounded()))% prepared", color: RadarTheme.blue, icon: "gauge")
                LoopOpsPill(text: "\(source.visibleDocumentCount) docs", color: RadarTheme.secondaryText, icon: "doc.text")
                LoopOpsPill(text: "Retries \(source.retryCount ?? 0)", color: RadarTheme.secondaryText, icon: "arrow.clockwise")
                LoopOpsPill(text: "Last sync \(loopOpsKnowledgeDateLabel(source.lastSyncedAt))", color: RadarTheme.secondaryText, icon: "clock")
            }
            if let error = source.errorSummary, !error.isEmpty {
                LoopOpsInlineNotice(icon: "exclamationmark.triangle", title: "Setup issue", detail: error)
            }
        }
        .padding(10)
        .background(RadarTheme.panelElevated.opacity(0.46))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
    }

    private func knowledgeRelations(_ source: LoopOpsKnowledgeSource) -> some View {
        let attachedRuns = (source.linkedRunIDs ?? []).compactMap { runID in
            store.runLedgers.first { $0.runID == runID }
        }
        let relationLabels = [
            (source.linkedRunIDs ?? []).isEmpty ? nil : "\((source.linkedRunIDs ?? []).count) runs",
            (source.relatedReviewPacketIDs ?? []).isEmpty ? nil : "\((source.relatedReviewPacketIDs ?? []).count) review packets",
            (source.relatedChatThreadIDs ?? []).isEmpty ? nil : "\((source.relatedChatThreadIDs ?? []).count) chats",
            (source.relatedToolLogIDs ?? []).isEmpty ? nil : "\((source.relatedToolLogIDs ?? []).count) tool logs"
        ].compactMap { $0 }
        return VStack(alignment: .leading, spacing: 6) {
            Text("Relations")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            if relationLabels.isEmpty {
                Text("No linked run or review source yet.")
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
            } else {
                FlowLayout(spacing: 6) {
                    ForEach(relationLabels, id: \.self) { label in
                        LoopOpsPill(text: label, color: RadarTheme.blue, icon: "link")
                    }
                }
            }
            if !attachedRuns.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Attached runs")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.mutedText)
                    ForEach(attachedRuns) { ledger in
                        HStack(spacing: 8) {
                            IconChip(systemName: ledger.domain.systemImage, tint: ledger.domain.tint, size: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ledger.title)
                                    .font(.system(size: 11.5, weight: .semibold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                    .lineLimit(1)
                                Text(ledger.status)
                                    .font(.system(size: 10.5))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Button {
                                detachKnowledge(source, from: ledger)
                            } label: {
                                Label("Detach", systemImage: "link.badge.minus")
                            }
                            .buttonStyle(ResearchSecondaryButtonStyle())
                        }
                        .padding(8)
                        .quietRow(cornerRadius: 9)
                    }
                }
            }
        }
    }

    private var knowledgeAttachSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                PanelHeader(icon: "paperclip", title: "Attach Knowledge", trailing: "\(store.runLedgers.count) runs")
                Spacer()
                Button("Done") {
                    attachTargetSheetPresented = false
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
            }
            if let selectedRow {
                LoopOpsKeyValue(label: "Source", value: selectedRow.title)
                if selectedRow.canAttach == false {
                    LoopOpsInlineNotice(
                        icon: "exclamationmark.triangle",
                        title: "Not ready",
                        detail: "This source needs review before it can be attached."
                    )
                }
            }
            if store.runLedgers.isEmpty {
                LoopOpsEmptyText(icon: "tray", title: "No runs yet", detail: "Run a Loop before attaching Knowledge.")
            } else {
                ScrollView {
                    VStack(spacing: 8) {
                        ForEach(store.runLedgers) { ledger in
                            Button {
                                attachSelectedRow(to: ledger)
                            } label: {
                                HStack(spacing: 10) {
                                    IconChip(systemName: ledger.domain.systemImage, tint: ledger.domain.tint, size: 28)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(ledger.title)
                                            .font(.system(size: 12.5, weight: .semibold))
                                            .foregroundStyle(RadarTheme.primaryText)
                                            .lineLimit(1)
                                        Text("\(ledger.status) · \(ledger.completedAt ?? ledger.startedAt ?? "time unavailable")")
                                            .font(.system(size: 11))
                                            .foregroundStyle(RadarTheme.secondaryText)
                                            .lineLimit(1)
                                    }
                                    Spacer()
                                    Image(systemName: "paperclip")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(RadarTheme.blue)
                                }
                                .padding(10)
                                .quietRow(cornerRadius: 10)
	                            }
	                            .buttonStyle(.plain)
                                .disabled(selectedRow?.canAttach == false)
	                        }
	                    }
	                }
	            }
        }
        .padding(16)
        .background(RadarTheme.background)
    }

    private func createKnowledge(_ kind: LoopOpsKnowledgeSourceKind) {
        let source = store.createKnowledgeSource(kind: kind)
        selectedID = source.id
        syncKnowledgeDraft(force: true)
    }

    private func syncKnowledgeSelection() {
        if selectedID == nil {
            selectedID = rows.first?.id
        }
        syncKnowledgeDraft(force: true)
    }

    private func syncKnowledgeDraftIfNeeded() {
        guard let source = selectedSource else {
            knowledgeDraftSourceID = nil
            return
        }
        if knowledgeDraftSourceID == nil || knowledgeDraftSourceID != source.id {
            syncKnowledgeDraft(force: true)
        }
    }

    private func syncKnowledgeDraft(force: Bool = false) {
        guard let source = selectedSource else {
            knowledgeDraftSourceID = nil
            knowledgeDraftTitle = selectedRow?.title ?? ""
            knowledgeDraftSummary = selectedRow?.summary ?? ""
            knowledgeDraftSourceLabel = selectedRow?.kind ?? ""
            knowledgeDraftBody = selectedRow?.summary ?? ""
            knowledgeDraftTags = ""
            knowledgeDraftURL = ""
            knowledgeDraftStatus = .draft
            knowledgeDraftReuseMode = .manual
            return
        }
        guard force || knowledgeDraftSourceID != source.id else { return }
        knowledgeDraftSourceID = source.id
        knowledgeDraftTitle = source.title
        knowledgeDraftSummary = source.summary
        knowledgeDraftSourceLabel = source.sourceLabel
        knowledgeDraftBody = source.bodyMarkdown ?? source.summary
        knowledgeDraftTags = (source.tags ?? []).joined(separator: ", ")
        knowledgeDraftURL = source.sourceURL ?? ""
        knowledgeDraftStatus = source.status
        knowledgeDraftReuseMode = source.reuseMode
    }

    private func saveKnowledgeDraft() {
        guard var source = selectedSource else { return }
        let title = knowledgeDraftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = knowledgeDraftSummary.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceLabel = knowledgeDraftSourceLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = knowledgeDraftBody.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceURL = knowledgeDraftURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let tags = knowledgeDraftTags
            .split(separator: ",")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !title.isEmpty, !summary.isEmpty, !sourceLabel.isEmpty else {
            store.showToast(
                title: "Knowledge needs fields",
                detail: "Name, summary and source label are required.",
                tone: .warning
            )
            return
        }
        source.title = title
        source.summary = summary
        source.sourceLabel = sourceLabel
        source.bodyMarkdown = body.isEmpty ? nil : body
        source.tags = tags.isEmpty ? nil : tags
        source.sourceURL = sourceURL.isEmpty ? nil : sourceURL
        source.status = knowledgeDraftStatus
        source.reuseMode = knowledgeDraftReuseMode
        if knowledgeDraftStatus == .ready {
            source.importProgress = 1
            source.errorSummary = nil
            source.documentCount = max(source.visibleDocumentCount, 1)
            source.lastSyncedAt = source.lastSyncedAt ?? Date()
        } else if source.importProgress == nil {
            source.importProgress = knowledgeDraftStatus == .syncing ? 0.35 : 0
        }
        var activity = source.activity ?? []
        activity.append("Edited source · \(AgentDateFormatting.isoString(Date()))")
        source.activity = Array(activity.suffix(10))
        store.upsertKnowledgeSource(source)
        selectedID = source.id
        knowledgeDraftSourceID = source.id
        store.showToast(
            title: "Knowledge saved",
            detail: "\(source.title) 已更新。",
            tone: .success
        )
    }

    private func startKnowledgeSetup(_ source: LoopOpsKnowledgeSource) {
        if let updated = store.startKnowledgeSourceSetup(id: source.id) {
            selectedID = updated.id
            syncKnowledgeDraft(force: true)
        }
    }

    private func completeKnowledgeSetup(_ source: LoopOpsKnowledgeSource) {
        if let updated = store.completeKnowledgeSourceSetup(id: source.id) {
            selectedID = updated.id
            syncKnowledgeDraft(force: true)
        }
    }

    private func detachKnowledge(_ source: LoopOpsKnowledgeSource, from ledger: RunLedgerRow) {
        if store.detachKnowledgeSource(id: source.id, fromRunID: ledger.runID, runTitle: ledger.title) {
            selectedID = source.id
            syncKnowledgeDraft(force: true)
        }
    }

    private func knowledgeMarkdown(for row: LoopOpsKnowledgeRowModel) -> String {
        if let packet = selectedReviewPacket {
            return """
            # \(row.title)

            Decision: \(loopOpsReviewDecisionDisplay(packet.reviewDecision))
            Run: \(packet.runID)

            ## Final Answer
            \(packet.finalAnswer)

            ## Claims
            \(packet.claims.isEmpty ? "No claims recorded." : packet.claims.joined(separator: "\n"))

            ## Evidence Gaps
            \(packet.evidenceGaps.isEmpty ? "No evidence gaps recorded." : packet.evidenceGaps.joined(separator: "\n"))

            ## Blocked Actions
            \(packet.blockedActions.isEmpty ? "No blocked actions recorded." : packet.blockedActions.joined(separator: "\n"))

            ## Next Questions
            \(packet.nextQuestions.isEmpty ? "No follow-up questions recorded." : packet.nextQuestions.joined(separator: "\n"))
            """
        }
        if let thread = selectedChatThread {
            let messages = thread.messages
                .map { "- \($0.role.rawValue.capitalized): \($0.text)" }
                .joined(separator: "\n")
            return """
            # \(row.title)

            Type: \(thread.scope.title)
            Messages: \(thread.messages.count)

            ## Transcript
            \(messages.isEmpty ? "No messages recorded." : messages)
            """
        }
        if let log = selectedToolLog {
            return """
            # \(row.title)

            Source: \(log.publicSourceLabel)
            Linked run: \(log.runID ?? "Not linked")
            Status: \(log.status)
            Review state: \(log.publicReviewState)

            ## Input
            \(log.publicInputSummary)

            ## Output
            \(log.publicOutputOrErrorSummary)
            """
        }
        return """
        # \(row.title)

        Type: \(row.kind)
        Status: \(row.detail)

        \(row.summary)
        """
    }

    private func materializeSelectedRow(_ row: LoopOpsKnowledgeRowModel) {
        let source = store.materializeKnowledgeSource(
            id: row.id,
            title: row.title,
            kind: row.sourceKind,
            summary: row.summary,
            sourceLabel: row.kind,
            linkedRunIDs: row.relatedRunID.map { [$0] },
            bodyMarkdown: knowledgeMarkdown(for: row),
            tags: [row.sourceKind.title],
            relatedReviewPacketIDs: row.relatedReviewPacketID.map { [$0] },
            relatedChatThreadIDs: row.relatedChatThreadID.map { [$0] },
            relatedToolLogIDs: row.relatedToolLogID.map { [$0] }
        )
        selectedID = source.id
        syncKnowledgeDraft(force: true)
        store.showToast(
            title: "Knowledge source saved",
            detail: "\(source.title) 可作为 source 复用。",
            tone: .success
        )
    }

    private func attachToLatestRun(_ row: LoopOpsKnowledgeRowModel) {
        guard let ledger = latestRunLedger else {
            store.showToast(
                title: "No run selected",
                detail: "Start a Loop before attaching Knowledge.",
                tone: .warning
            )
            return
        }
        attachRow(row, to: ledger)
    }

    private func attachSelectedRow(to ledger: RunLedgerRow) {
        guard let row = selectedRow else { return }
        attachRow(row, to: ledger)
        attachTargetSheetPresented = false
    }

    private func attachRow(_ row: LoopOpsKnowledgeRowModel, to ledger: RunLedgerRow) {
        let sourceID: String
        if store.knowledgeSources.contains(where: { $0.id == row.id }) {
            sourceID = row.id
        } else {
            let source = store.materializeKnowledgeSource(
                id: row.id,
                title: row.title,
                kind: row.sourceKind,
                summary: row.summary,
                sourceLabel: row.kind,
                linkedRunIDs: row.relatedRunID.map { [$0] },
                bodyMarkdown: row.summary,
                tags: [row.sourceKind.title],
                relatedReviewPacketIDs: row.relatedReviewPacketID.map { [$0] },
                relatedChatThreadIDs: row.relatedChatThreadID.map { [$0] },
                relatedToolLogIDs: row.relatedToolLogID.map { [$0] }
            )
            sourceID = source.id
        }
        if store.attachKnowledgeSource(id: sourceID, toRunID: ledger.runID, runTitle: ledger.title) {
            selectedID = sourceID
            syncKnowledgeDraft(force: true)
        } else {
            selectedID = sourceID
            syncKnowledgeDraft(force: true)
        }
    }
}

struct LoopOpsStudioView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var store: LoopOpsLocalStore
    let metrics: WorkbenchLayoutMetrics

    @State private var selectedContractID: String?
    @State private var draft = LoopContractDraft(
        id: "",
        name: "",
        domain: .crypto,
        goal: "",
        trigger: "",
        inputBindingsText: "",
        capabilityChainText: "",
        skillBindings: [],
        stepSummaryText: "",
        feedbackGate: "",
        exitCondition: "",
        reviewBoundary: "",
        outputShape: "",
        prompt: ""
    )
    @State private var builderPackets: [LoopOpsBuilderPacket] = []
    @State private var selectedBuilderPacketID: String?
    @State private var studioSkillQuery = ""

    private var selectedContractExact: LoopContract? {
        if let selectedContractID {
            return store.allContractsForDisplay.first { $0.id == selectedContractID }
        }
        if let focusedID = viewModel.loopOpsFocusedContractID {
            return store.allContractsForDisplay.first { $0.id == focusedID }
        }
        return nil
    }

    private var selectedContract: LoopContract? {
        if let selectedContractExact {
            return selectedContractExact
        }
        if selectedContractID != nil {
            return nil
        }
        if let focusedID = viewModel.loopOpsFocusedContractID {
            return store.allContractsForDisplay.first { $0.id == focusedID }
        }
        return store.allContractsForDisplay.first
    }

    private var builderPacketScopeID: String {
        draft.id.isEmpty ? "draft" : draft.id
    }

    private var studioPackages: [LoopOpsSkillPackage] {
        LoopOpsSkillPackage.packages(from: viewModel, toolDrafts: store.toolDrafts)
    }

    private var filteredStudioPackages: [LoopOpsSkillPackage] {
        let trimmed = studioSkillQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return studioPackages }
        return studioPackages.filter {
            "\($0.title) \($0.description) \($0.kind.title) \($0.domainLabel)"
                .localizedCaseInsensitiveContains(trimmed)
        }
    }

    private var readyKnowledgeSources: [LoopOpsKnowledgeSource] {
        store.knowledgeSources.filter(\.canAttachToRun)
    }

    private var selectedKnowledgeSources: [LoopOpsKnowledgeSource] {
        let byID = Dictionary(uniqueKeysWithValues: store.knowledgeSources.map { ($0.id, $0) })
        return draft.knowledgeSourceIDs.compactMap { byID[$0] }
    }

    private var selectedSkillStack: LoopOpsSkillStack? {
        guard let stackID = draft.skillStackID else { return nil }
        return store.allSkillStacksForDisplay.first { $0.id == stackID }
    }

    private var unavailableKnowledgeBindingCount: Int {
        selectedKnowledgeSources.filter { !$0.canAttachToRun }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LoopOpsPageHeader(
                title: "Studio",
                subtitle: "Build and edit Loop blueprints with Builder Chat.",
                icon: "slider.horizontal.3",
                trailing: draft.domain.title
            )

            if metrics.isCompact {
                VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                    contractPicker
                    skillShelf
                    contractEditor
                    builderChat
                }
            } else {
                HStack(alignment: .top, spacing: metrics.workspaceSpacing) {
                    VStack(alignment: .leading, spacing: metrics.workspaceSpacing) {
                        contractPicker
                        skillShelf
                    }
                        .frame(width: metrics.queueColumnWidth)
                    contractEditor
                        .frame(maxWidth: .infinity)
                    builderChat
                        .frame(width: metrics.supportColumnWidth)
                }
            }
        }
        .onAppear(perform: loadInitialDraft)
        .onChange(of: selectedContractID) { _, _ in loadInitialDraft() }
        .onChange(of: viewModel.loopOpsFocusedContractID) { _, focusedID in
            guard let focusedID else { return }
            selectedContractID = focusedID
            loadInitialDraft()
        }
        .onChange(of: draft.skillBindings) { _, bindings in
            draft.capabilityChainText = LoopOpsSkillBinding.ordered(bindings).map(\.title).joined(separator: "\n")
        }
        .accessibilityIdentifier("loopops.studio")
    }

    private var contractPicker: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "arrow.triangle.2.circlepath", title: "Loop Pages", trailing: "\(store.allContractsForDisplay.count)")
            ForEach(store.allContractsForDisplay.prefix(14)) { contract in
                Button {
                    selectedContractID = contract.id
                    viewModel.loopOpsFocusedContractID = contract.id
                } label: {
                    LoopOpsContractRow(contract: contract, selected: draft.id == contract.id)
                }
                .buttonStyle(.plain)
            }
            Button {
                draft = LoopContractDraft(
                    id: "loop-\(UUID().uuidString)",
                    name: "Untitled Loop",
                    domain: .crypto,
                    goal: "Describe the recurring job.",
                    trigger: "Manual run",
                    inputBindingsText: "Current workspace context",
                    capabilityChainText: "CMC Skill Hub",
                    skillBindings: LoopOpsSkillBinding.from(
                        skillIDs: ["cmc-market-radar", "market-regime-review"],
                        extensionIDs: ["cmc-skill-hub"],
                        source: "new-loop"
                    ),
                    stepSummaryText: "Collect inputs\nRun selected execution path\nDraft final answer\nReview output",
                    feedbackGate: "Human review before external action.",
                    exitCondition: "Final answer and next questions.",
                    reviewBoundary: "Review first; no external execution.",
                    outputShape: "Final answer, evidence gaps, next steps.",
                    prompt: "运行这个 Loop，并保持人工复核边界。"
                )
                selectedContractID = draft.id
                viewModel.loopOpsFocusedContractID = draft.id
            } label: {
                Label("New Loop Draft", systemImage: "plus")
            }
            .buttonStyle(ResearchSecondaryButtonStyle())
            .accessibilityIdentifier(LoopOpsInteractionID.buildCreateButton)
        }
        .padding(14)
        .radarPanel()
    }

    private var skillShelf: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "square.stack.3d.up", title: "Skill OS Shelf", trailing: "\(filteredStudioPackages.count) of \(studioPackages.count)")
            TextField("Search skills or local tools...", text: $studioSkillQuery)
                .loopOpsField()
            if filteredStudioPackages.isEmpty {
                LoopOpsEmptyText(icon: "magnifyingglass", title: "No matching skills", detail: "Adjust the search or open Skill OS for the full database.")
            }
            ForEach(filteredStudioPackages.prefix(12)) { package in
                LoopOpsSkillPackageRow(package: package, selected: draft.skillBindings.contains { $0.kind == package.kind && $0.id == package.id })
                    .onDrag { NSItemProvider(object: package.dragPayload as NSString) }
                    .contextMenu {
                        Button("Add to path") { add(package) }
                    }
            }
            Divider().overlay(RadarTheme.borderSoft)
            ForEach(store.allSkillStacksForDisplay.prefix(4)) { stack in
                LoopOpsSkillStackRow(stack: stack)
                    .onDrag { NSItemProvider(object: "loopops-stack|\(stack.id)" as NSString) }
                    .contextMenu {
                        Button("Apply stack") { apply(stack) }
                    }
            }
        }
        .padding(14)
        .radarPanel()
        .accessibilityIdentifier(LoopOpsInteractionID.studioSkillShelf)
    }

    private var contractEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            let previewContract = draft.materialize(existing: selectedContractExact)
            PanelHeader(icon: "doc.badge.gearshape", title: "Loop Blueprint", trailing: draft.id.isEmpty ? "draft" : "editable")
            if let packet = selectedBuilderPacket {
                LoopOpsBuilderPacketPanel(
                    packet: packet,
                    diffRows: diffRows(for: packet),
                    apply: { applyBuilderPacket(packet.id) },
                    reject: { rejectBuilderPacket(packet.id) },
                    save: { saveBuilderPacket(packet.id) }
                )
            }
            TextField("Name", text: $draft.name)
                .loopOpsField()
            Picker("Domain", selection: $draft.domain) {
                ForEach(WorkbenchDomain.allCases) { domain in
                    Text(domain.title).tag(domain)
                }
            }
            .pickerStyle(.segmented)
            TextField("Goal", text: $draft.goal, axis: .vertical)
                .lineLimit(2...4)
                .loopOpsField()
            TextField("Trigger", text: $draft.trigger, axis: .vertical)
                .lineLimit(1...3)
                .loopOpsField()
            LoopOpsEditorSection(title: "Inputs", text: $draft.inputBindingsText)
            knowledgeBinder
            skillStackBinder
            LoopOpsSkillPathEditor(
                bindings: $draft.skillBindings,
                stacks: store.allSkillStacksForDisplay,
                title: "Execution Path",
                applyDrop: applySkillDrop(_:before:),
                onManualEdit: { draft.skillStackID = nil }
            )
            LoopOpsEditorSection(title: "Path Notes", text: $draft.capabilityChainText)
            LoopOpsEditorSection(title: "Steps", text: $draft.stepSummaryText)
            TextField("Review Rule", text: $draft.feedbackGate, axis: .vertical)
                .lineLimit(2...4)
                .loopOpsField()
            TextField("Exit Condition", text: $draft.exitCondition, axis: .vertical)
                .lineLimit(2...4)
                .loopOpsField()
            TextField("Review Boundary", text: $draft.reviewBoundary, axis: .vertical)
                .lineLimit(2...4)
                .loopOpsField()
            TextField("Output Shape", text: $draft.outputShape, axis: .vertical)
                .lineLimit(2...4)
                .loopOpsField()
            TextField("Prompt", text: $draft.prompt, axis: .vertical)
                .lineLimit(3...7)
                .loopOpsField()
            if !previewContract.isRunnable {
                LoopOpsInlineNotice(
                    icon: "exclamationmark.triangle",
                    title: "Setup needed",
                    detail: previewContract.setupChecklistSummary
                )
            }
            HStack(spacing: 8) {
                Button("Save Draft", action: saveDraft)
                    .buttonStyle(ResearchPrimaryButtonStyle())
                    .accessibilityIdentifier(LoopOpsInteractionID.studioSaveLoop)
                Button("Run Preview") {
                    guard let contract = persistDraft(requireRunnable: true, showSaveToast: false) else { return }
                    let report = viewModel.runLoopContract(contract, loopOpsStore: store)
                    if report.pendingCount > 0 || report.queuedCount > 0 {
                        viewModel.select(workspace: .home)
                    }
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .disabled(!previewContract.isRunnable)
                .accessibilityIdentifier(LoopOpsInteractionID.studioRunPreview)
            }
        }
        .padding(14)
        .radarPanel()
        .accessibilityIdentifier(LoopOpsInteractionID.studioContractEditor)
    }

    private var knowledgeBinder: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Knowledge")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                Spacer(minLength: 0)
                Menu {
                    if readyKnowledgeSources.isEmpty {
                        Text("No ready sources")
                    } else {
                        ForEach(readyKnowledgeSources) { source in
                            Button {
                                toggleKnowledgeSource(source)
                            } label: {
                                Label(
                                    source.title,
                                    systemImage: draft.knowledgeSourceIDs.contains(source.id) ? "checkmark.circle.fill" : source.kind.systemImage
                                )
                            }
                        }
                    }
                } label: {
                    Label("Attach", systemImage: "plus")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .disabled(readyKnowledgeSources.isEmpty)
            }

            if selectedKnowledgeSources.isEmpty {
                LoopOpsEmptyText(
                    icon: "tray.full",
                    title: "No Knowledge attached",
                    detail: "Attach ready sources so this Loop can pass them into the run context and Run Chat."
                )
            } else {
                VStack(spacing: 0) {
                    ForEach(selectedKnowledgeSources) { source in
                        HStack(spacing: 9) {
                            IconChip(systemName: source.kind.systemImage, tint: source.canAttachToRun ? RadarTheme.green : RadarTheme.gold, size: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(source.title)
                                    .font(.system(size: 12.5, weight: .semibold))
                                    .foregroundStyle(RadarTheme.primaryText)
                                    .lineLimit(1)
                                Text("\(source.sourceLabel) · \(source.status.title)")
                                    .font(.system(size: 10.5))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Button {
                                removeKnowledgeSource(source.id)
                            } label: {
                                Image(systemName: "xmark")
                            }
                            .buttonStyle(HoverIconButtonStyle(size: 26))
                        }
                        .padding(8)
                        .quietRow(selected: source.canAttachToRun, cornerRadius: 8)
                    }
                }
            }

            if unavailableKnowledgeBindingCount > 0 {
                LoopOpsInlineNotice(
                    icon: "exclamationmark.triangle",
                    title: "Knowledge not ready",
                    detail: "\(unavailableKnowledgeBindingCount) attached source(s) need review before they can be injected into a run."
                )
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.studioKnowledge)
    }

    private var skillStackBinder: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Skill Stack")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                Spacer(minLength: 0)
                Menu {
                    if store.allSkillStacksForDisplay.isEmpty {
                        Text("No saved stacks")
                    } else {
                        ForEach(store.allSkillStacksForDisplay) { stack in
                            Button {
                                apply(stack)
                            } label: {
                                Label(
                                    stack.name,
                                    systemImage: draft.skillStackID == stack.id ? "checkmark.circle.fill" : "square.stack.3d.up"
                                )
                            }
                        }
                    }
                    if draft.skillStackID != nil {
                        Divider()
                        Button("Clear stack link") {
                            draft.skillStackID = nil
                        }
                    }
                } label: {
                    Label(selectedSkillStack?.name ?? "Choose stack", systemImage: "square.stack.3d.up")
                }
                .buttonStyle(ResearchSecondaryButtonStyle())
                .disabled(store.allSkillStacksForDisplay.isEmpty && draft.skillStackID == nil)
            }

            if let selectedSkillStack {
                HStack(spacing: 9) {
                    IconChip(systemName: "square.stack.3d.up", tint: RadarTheme.green, size: 28)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(selectedSkillStack.name)
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
                        Text("\(selectedSkillStack.bindings.count) steps · saved Skill OS stack")
                            .font(.system(size: 10.5))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button {
                        draft.skillStackID = nil
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(HoverIconButtonStyle(size: 26))
                }
                .padding(8)
                .quietRow(selected: true, cornerRadius: 8)
            } else {
                LoopOpsEmptyText(
                    icon: "square.stack.3d.up",
                    title: "No stack linked",
                    detail: "Choose a saved Skill OS stack or drag one into the execution path."
                )
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.studioSkillStack)
    }

    private var builderChat: some View {
        LoopOpsScopedChatPanel(
            viewModel: viewModel,
            store: store,
            scope: .builder,
            scopeID: builderPacketScopeID,
            title: draft.name.isEmpty ? "Loop draft" : draft.name,
            selectedRun: nil,
            selectedContract: selectedContract,
            onBuilderInstruction: applyBuilderInstruction(_:)
        )
    }

    private func loadInitialDraft() {
        guard let selectedContract else {
            builderPackets = []
            selectedBuilderPacketID = nil
            return
        }
        draft = LoopContractDraft.from(contract: selectedContract)
        selectedContractID = selectedContract.id
        builderPackets = store.builderPackets(forContractID: selectedContract.id)
        selectedBuilderPacketID = builderPackets.first?.id
    }

    private func saveDraft() {
        _ = persistDraft(requireRunnable: false)
    }

    private func persistDraft(requireRunnable: Bool, showSaveToast: Bool = true) -> LoopContract? {
        let previousPacketScopeID = builderPacketScopeID
        let existing = selectedContractExact?.id == draft.id ? selectedContractExact : nil
        let contract = draft.materialize(existing: existing)
        if requireRunnable, !contract.isRunnable {
            store.showToast(title: "Setup needed", detail: contract.setupChecklistItems.first ?? "Finish the Loop blueprint.", tone: .warning)
            return nil
        }
        store.upsert(contract)
        store.reassignBuilderPackets(from: previousPacketScopeID, to: contract.id)
        store.reassignBuilderThread(from: previousPacketScopeID, to: contract.id, title: contract.name)
        selectedContractID = contract.id
        draft = LoopContractDraft.from(contract: contract)
        if let selectedBuilderPacketID {
            updateBuilderPacket(selectedBuilderPacketID, status: .saved)
        }
        builderPackets = store.builderPackets(forContractID: contract.id)
        selectedBuilderPacketID = builderPackets.first?.id
        if showSaveToast {
            if contract.isRunnable {
                store.showToast(title: "Loop saved", detail: "\(contract.name) is ready to run.", tone: .success)
            } else {
                store.showToast(title: "Draft saved", detail: "Saved as a Loop page. Finish setup before Run Preview.", tone: .warning)
            }
        }
        return contract
    }

    private func add(_ package: LoopOpsSkillPackage) {
        insert(package.binding(order: draft.skillBindings.count, source: "studio"), before: nil)
    }

    private func apply(_ stack: LoopOpsSkillStack) {
        draft.applySkillStack(stack)
    }

    private func insert(_ binding: LoopOpsSkillBinding, before beforeID: String?) {
        draft.applyCustomSkillBindings(LoopOpsSkillPathDropResolver.insert(
            binding,
            before: beforeID,
            into: draft.skillBindings
        ))
    }

    private func applySkillDrop(_ payload: String, before beforeID: String?) {
        let parts = payload.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        if parts.first == "loopops-stack", parts.count >= 2 {
            if let stack = store.allSkillStacksForDisplay.first(where: { $0.id == parts[1] }) {
                draft.applySkillStack(stack)
            }
            return
        }
        draft.applyCustomSkillBindings(LoopOpsSkillPathDropResolver.apply(
            payload: payload,
            before: beforeID,
            to: draft.skillBindings,
            stacks: store.allSkillStacksForDisplay
        ))
    }

    private func toggleKnowledgeSource(_ source: LoopOpsKnowledgeSource) {
        if draft.knowledgeSourceIDs.contains(source.id) {
            removeKnowledgeSource(source.id)
        } else {
            draft.knowledgeSourceIDs.append(source.id)
            store.showToast(title: "Knowledge attached", detail: "\(source.title) will be passed into this Loop run.", tone: .success)
        }
    }

    private func removeKnowledgeSource(_ sourceID: String) {
        draft.knowledgeSourceIDs.removeAll { $0 == sourceID }
    }

    private func applyBuilderInstruction(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        let patch = LoopOpsBuilderDraftPatch(
            instruction: value,
            packages: LoopOpsSkillPackage.packages(from: viewModel, toolDrafts: store.toolDrafts),
            knowledgeSources: readyKnowledgeSources
        )
        let packet = LoopOpsBuilderPacket(contractID: builderPacketScopeID, instruction: value, patch: patch)
        builderPackets.insert(packet, at: 0)
        selectedBuilderPacketID = packet.id
        store.upsertBuilderPacket(packet)
        store.showToast(
            title: patch.hasChanges ? "Builder update pending" : "Builder update needs structure",
            detail: patch.receiptEvidence,
            tone: patch.hasChanges ? .info : .warning
        )
        return "修改预览待复核。\n\(patch.receiptText)"
    }

    private var selectedBuilderPacket: LoopOpsBuilderPacket? {
        if let selectedBuilderPacketID {
            return builderPackets.first { $0.id == selectedBuilderPacketID }
        }
        return builderPackets.first
    }

    private func applyBuilderPacket(_ id: String) {
        guard let packet = builderPackets.first(where: { $0.id == id }),
              packet.status == .pending,
              packet.patch.hasChanges else { return }
        draft.apply(packet.patch)
        updateBuilderPacket(id, status: .applied)
        store.appendMessage(
            scope: .builder,
            scopeID: builderPacketScopeID,
            title: draft.name.isEmpty ? "Loop draft" : draft.name,
            role: .assistant,
            text: "Builder update applied: \(packet.patch.receiptEvidence)"
        )
    }

    private func rejectBuilderPacket(_ id: String) {
        guard let packet = builderPackets.first(where: { $0.id == id }),
              packet.status == .pending else { return }
        updateBuilderPacket(id, status: .rejected)
        store.appendMessage(
            scope: .builder,
            scopeID: builderPacketScopeID,
            title: draft.name.isEmpty ? "Loop draft" : draft.name,
            role: .assistant,
            text: "Builder update rejected; Loop 蓝图保持不变。"
        )
    }

    private func saveBuilderPacket(_ id: String) {
        guard let packet = builderPackets.first(where: { $0.id == id }),
              packet.status == .applied else { return }
        saveDraft()
    }

    private func updateBuilderPacket(_ id: String, status: LoopOpsBuilderPacketStatus) {
        guard let index = builderPackets.firstIndex(where: { $0.id == id }) else { return }
        let updated = store.updateBuilderPacket(id: id, status: status) ?? builderPackets[index].updating(status: status)
        builderPackets[index] = updated
        selectedBuilderPacketID = id
    }

    private func diffRows(for packet: LoopOpsBuilderPacket) -> [LoopOpsBuilderDiffRow] {
        var preview = draft
        preview.apply(packet.patch)
        let skillPath = draft.skillBindings.map(\.title).joined(separator: " -> ")
        let previewSkillPath = preview.skillBindings.map(\.title).joined(separator: " -> ")
        let knowledgePath = knowledgeLabels(for: draft.knowledgeSourceIDs)
        let previewKnowledgePath = knowledgeLabels(for: preview.knowledgeSourceIDs)
        var rows: [LoopOpsBuilderDiffRow] = []
        appendDiff("Name", before: draft.name, after: preview.name, rows: &rows)
        appendDiff("Goal", before: draft.goal, after: preview.goal, rows: &rows)
        appendDiff("Trigger", before: draft.trigger, after: preview.trigger, rows: &rows)
        appendDiff("Inputs", before: draft.inputBindingsText, after: preview.inputBindingsText, rows: &rows)
        appendDiff("Steps", before: draft.stepSummaryText, after: preview.stepSummaryText, rows: &rows)
        appendDiff("Execution Path", before: skillPath, after: previewSkillPath, rows: &rows)
        appendDiff("Knowledge", before: knowledgePath, after: previewKnowledgePath, rows: &rows)
        appendDiff("Review Rule", before: draft.feedbackGate, after: preview.feedbackGate, rows: &rows)
        appendDiff("Exit", before: draft.exitCondition, after: preview.exitCondition, rows: &rows)
        appendDiff("Boundary", before: draft.reviewBoundary, after: preview.reviewBoundary, rows: &rows)
        appendDiff("Output", before: draft.outputShape, after: preview.outputShape, rows: &rows)
        return rows.isEmpty
            ? [LoopOpsBuilderDiffRow(label: "Blueprint", before: "No visible field change", after: packet.patch.receiptStatus)]
            : rows
    }

    private func knowledgeLabels(for ids: [String]) -> String {
        let byID = Dictionary(uniqueKeysWithValues: store.knowledgeSources.map { ($0.id, $0.title) })
        let labels = ids.map { byID[$0] ?? $0 }
        return labels.joined(separator: " -> ")
    }

    private func appendDiff(_ label: String, before: String, after: String, rows: inout [LoopOpsBuilderDiffRow]) {
        guard before != after else { return }
        rows.append(
            LoopOpsBuilderDiffRow(
                label: label,
                before: before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "empty" : before,
                after: after.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "empty" : after
            )
        )
    }
}

private struct LoopOpsBuilderDiffRow: Identifiable, Hashable {
    var id: String { label }
    var label: String
    var before: String
    var after: String
}

private struct LoopOpsBuilderPacketPanel: View {
    let packet: LoopOpsBuilderPacket
    let diffRows: [LoopOpsBuilderDiffRow]
    let apply: () -> Void
    let reject: () -> Void
    let save: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LoopOpsBuilderPatchReceiptView(patch: packet.patch, statusLabel: packet.status.title)
            VStack(alignment: .leading, spacing: 6) {
                Text("Changes")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                ForEach(diffRows) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.label)
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                        HStack(alignment: .top, spacing: 8) {
                            LoopOpsBuilderDiffValue(title: "Before", value: row.before)
                            LoopOpsBuilderDiffValue(title: "After", value: row.after)
                        }
                    }
                    .padding(8)
                    .background(RadarTheme.panelElevated)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
            .accessibilityIdentifier(LoopOpsInteractionID.studioBuilderPacketDiffRows)

            HStack(spacing: 8) {
                Button("Apply", action: apply)
                    .buttonStyle(ResearchPrimaryButtonStyle())
                    .disabled(packet.status != .pending || !packet.patch.hasChanges)
                    .accessibilityIdentifier(LoopOpsInteractionID.studioBuilderPacketApply)
                Button("Reject", action: reject)
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .disabled(packet.status != .pending)
                    .accessibilityIdentifier(LoopOpsInteractionID.studioBuilderPacketReject)
                Button("Save", action: save)
                    .buttonStyle(ResearchSecondaryButtonStyle())
                    .disabled(packet.status != .applied)
                    .accessibilityIdentifier(LoopOpsInteractionID.studioBuilderPacketSave)
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.studioBuilderPacket)
    }
}

private struct LoopOpsBuilderDiffValue: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            Text(value)
                .font(.system(size: 11.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct LoopOpsBuilderPatchReceiptView: View {
    let patch: LoopOpsBuilderDraftPatch
    var statusLabel: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: patch.hasChanges ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(patch.hasChanges ? RadarTheme.green : RadarTheme.gold)
                Text(patch.receiptStatus)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .accessibilityIdentifier(LoopOpsInteractionID.studioBuilderPatchReceiptStatus)
                Spacer(minLength: 0)
                LoopOpsPill(
                    text: statusLabel ?? (patch.hasChanges ? "blueprint updated" : "needs labels"),
                    color: patch.hasChanges ? RadarTheme.green : RadarTheme.gold,
                    icon: patch.hasChanges ? "doc.badge.gearshape" : "text.magnifyingglass"
                )
            }
            VStack(alignment: .leading, spacing: 5) {
                ForEach(patch.receiptLines, id: \.self) { line in
                    Text(line)
                        .font(.system(size: 11.5))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(patch.receiptEvidence)
                .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                .foregroundStyle(RadarTheme.mutedText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RadarTheme.tintFaint)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
        .accessibilityIdentifier(LoopOpsInteractionID.studioBuilderPatchReceipt)
    }
}

func loopOpsKnowledgeCount(_ count: Int, singular: String, plural: String) -> String {
    "\(count) \(count == 1 ? singular : plural)"
}

func loopOpsKnowledgeDateLabel(_ date: Date?) -> String {
    guard let date else { return "Not dated" }
    return date.formatted(date: .abbreviated, time: .omitted)
}

func loopOpsKnowledgeThreadDetail(messageCount: Int, reusableNoteCount: Int) -> String {
    "\(loopOpsKnowledgeCount(messageCount, singular: "message", plural: "messages")) · \(loopOpsKnowledgeCount(reusableNoteCount, singular: "reusable note", plural: "reusable notes"))"
}

private enum LoopOpsKnowledgeStatusFilter: String, CaseIterable, Identifiable, Hashable {
    case all
    case ready
    case syncing
    case draft
    case needsReview
    case stale
    case failed

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All statuses"
        case .ready: return "Ready"
        case .syncing: return "Syncing"
        case .draft: return "Draft"
        case .needsReview: return "Needs review"
        case .stale: return "Stale"
        case .failed: return "Failed"
        }
    }

    func accepts(_ status: LoopOpsKnowledgeSourceStatus) -> Bool {
        switch self {
        case .all:
            return true
        case .ready:
            return status == .ready
        case .syncing:
            return status == .syncing
        case .draft:
            return status == .draft
        case .needsReview:
            return status == .needsReview
        case .stale:
            return status == .stale
        case .failed:
            return status == .failed
        }
    }
}

private struct LoopOpsKnowledgeStarterModel: Identifiable, Hashable {
    var kind: LoopOpsKnowledgeSourceKind
    var title: String
    var summary: String
    var icon: String

    var id: String { kind.rawValue }
}

private struct LoopOpsKnowledgeRowModel: Identifiable, Hashable {
    var id: String
    var title: String
    var kind: String
    var sourceKind: LoopOpsKnowledgeSourceKind
    var summary: String
    var detail: String
    var documentLabel: String
    var linkedLabel: String
    var updatedLabel: String
    var statusLabel: String
    var ownerLabel: String
    var updatedAt: Date?
    var progressLabel: String = "0%"
    var errorSummary: String? = nil
    var retryCount: Int = 0
    var lastSyncedLabel: String = "Not synced"
    var canAttach: Bool = false
    var relatedRunID: String? = nil
    var relatedReviewPacketID: String? = nil
    var relatedChatThreadID: String? = nil
    var relatedToolLogID: String? = nil
}

private struct LoopOpsKnowledgeStarterButton: View {
    let starter: LoopOpsKnowledgeStarterModel

    var body: some View {
        HStack(spacing: 8) {
            IconChip(systemName: starter.icon, tint: RadarTheme.blue, size: 26)
            VStack(alignment: .leading, spacing: 2) {
                Text(starter.title)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(starter.summary)
                    .font(.system(size: 10.2))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 8)
        .quietRow(cornerRadius: 9)
    }
}

private struct LoopOpsManagementHero: View {
    let title: String
    let subtitle: String
    let icon: String
    let segments: [String]

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            IconChip(systemName: icon, tint: RadarTheme.blue, size: 36)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
            Spacer(minLength: 12)
            HStack(spacing: 4) {
                ForEach(segments, id: \.self) { segment in
                    Text(segment)
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(segment == segments.first ? RadarTheme.blue.opacity(0.12) : RadarTheme.panelElevated)
                        .clipShape(Capsule())
                }
            }
        }
        .padding(14)
        .background(RadarTheme.tintFaint)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
    }
}

private struct LoopOpsToolSelectionSummary: View {
    let bindings: [LoopOpsSkillBinding]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(icon: "checklist", title: "Current stack", trailing: "\(bindings.count)")
            if bindings.isEmpty {
                LoopOpsEmptyText(icon: "checklist", title: "No enabled tools", detail: "Enable tools from the detail page to assemble a stack.")
            } else {
                LoopOpsSkillPathList(bindings: bindings, title: "Enabled execution path")
            }
        }
        .padding(14)
        .radarPanel()
    }
}

private struct LoopOpsResourceTableHeader: View {
    let columns: [String]

    var body: some View {
        HStack(spacing: 12) {
            ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                Text(column)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                    .frame(width: fixedWidth(for: index), alignment: .leading)
                    .frame(maxWidth: index == 0 ? .infinity : nil, alignment: .leading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(RadarTheme.panelElevated)
    }

    private func fixedWidth(for index: Int) -> CGFloat? {
        guard index > 0 else { return nil }
        if columns.count >= 5 {
            switch index {
            case 1: return 110
            case 2: return 108
            case 3: return 104
            default: return 118
            }
        }
        return 140
    }
}

private struct LoopOpsToolTableHeader: View {
    let columns: Set<LoopOpsToolColumn>

    var body: some View {
        HStack(spacing: 12) {
            ForEach(LoopOpsToolColumn.allCases.filter { columns.contains($0) }) { column in
                Text(column.title)
                    .frame(width: column.width, alignment: .leading)
                    .frame(maxWidth: column == .name ? .infinity : nil, alignment: .leading)
            }
        }
        .font(.system(size: 10.5, weight: .semibold))
        .foregroundStyle(RadarTheme.mutedText)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(RadarTheme.panelElevated)
    }
}

private struct LoopOpsSkillPackageTableRow: View {
    let package: LoopOpsSkillPackage
    let selected: Bool
    let columns: Set<LoopOpsToolColumn>

    var body: some View {
        HStack(spacing: 12) {
            ForEach(LoopOpsToolColumn.allCases.filter { columns.contains($0) }) { column in
                switch column {
                case .name:
                    HStack(spacing: 10) {
                        Image(systemName: package.selected ? "checkmark.square.fill" : "square")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(package.selected ? RadarTheme.green : RadarTheme.mutedText)
                        IconChip(systemName: package.kind == .skill ? "wand.and.stars" : "shippingbox", tint: package.selected ? RadarTheme.blue : RadarTheme.secondaryText, size: 28)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(package.title)
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            Text(package.description)
                                .font(.system(size: 11))
                                .foregroundStyle(RadarTheme.secondaryText)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                case .type:
                    Text(package.kind.title)
                        .frame(width: column.width, alignment: .leading)
                case .integrations:
                    Text(package.integrationLabel)
                        .frame(width: column.width, alignment: .leading)
                case .usedBy:
                    Text(package.usedByLabel)
                        .frame(width: column.width, alignment: .leading)
                case .owner:
                    Text(package.ownerLabel)
                        .frame(width: column.width, alignment: .leading)
                case .status:
                    Text(package.selected ? "Enabled" : package.status)
                        .frame(width: column.width, alignment: .leading)
                case .modified:
                    Text(package.updatedLabel)
                        .frame(width: column.width, alignment: .leading)
                }
            }
        }
        .font(.system(size: 11.5))
        .foregroundStyle(RadarTheme.secondaryText)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(selected ? RadarTheme.blue.opacity(0.09) : Color.clear)
        .contentShape(Rectangle())
    }
}

private struct LoopOpsWorkforceRow: View {
    let stack: LoopOpsSkillStack
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 10) {
                IconChip(systemName: "person.3.sequence", tint: RadarTheme.green, size: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(stack.name)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Text(stack.summary)
                        .font(.system(size: 11))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text("\(stack.bindings.count) tools")
                .frame(width: 140, alignment: .leading)
            Text("Saved")
                .frame(width: 140, alignment: .leading)
        }
        .font(.system(size: 11.5))
        .foregroundStyle(RadarTheme.secondaryText)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(selected ? RadarTheme.blue.opacity(0.09) : Color.clear)
        .contentShape(Rectangle())
    }
}

private struct LoopOpsKnowledgeRow: View {
    let row: LoopOpsKnowledgeRowModel
    let selected: Bool

    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 10) {
                IconChip(systemName: row.sourceKind.systemImage, tint: RadarTheme.gold, size: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Text(row.summary)
                        .font(.system(size: 11))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(1)
                    Text("\(row.documentLabel) · \(row.updatedLabel)")
                        .font(.system(size: 10.5))
                        .foregroundStyle(RadarTheme.mutedText)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(row.kind)
                .frame(width: 110, alignment: .leading)
                .lineLimit(1)
            Text(row.documentLabel)
                .frame(width: 98, alignment: .leading)
                .lineLimit(1)
            Text(row.linkedLabel)
                .frame(width: 92, alignment: .leading)
                .lineLimit(1)
            Text(row.updatedLabel)
                .frame(width: 104, alignment: .leading)
                .lineLimit(1)
            LoopOpsPill(text: row.statusLabel, color: statusColor, icon: statusIcon)
                .frame(width: 118, alignment: .leading)
                .lineLimit(1)
        }
        .font(.system(size: 11.5))
        .foregroundStyle(RadarTheme.secondaryText)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(selected ? RadarTheme.blue.opacity(0.09) : Color.clear)
        .contentShape(Rectangle())
    }

    private var statusColor: Color {
        let status = row.statusLabel.lowercased()
        if status.contains("ready") || status.contains("reviewed") { return RadarTheme.green }
        if status.contains("need") || status.contains("follow") || status.contains("input") { return RadarTheme.gold }
        if status.contains("block") || status.contains("failed") { return RadarTheme.red }
        return RadarTheme.blue
    }

    private var statusIcon: String {
        let status = row.statusLabel.lowercased()
        if status.contains("ready") || status.contains("reviewed") { return "checkmark.circle" }
        if status.contains("need") || status.contains("input") { return "exclamationmark.triangle" }
        if status.contains("block") || status.contains("failed") { return "xmark.circle" }
        return "doc.text"
    }
}

private struct LoopOpsPageHeader: View {
    let title: String
    let subtitle: String
    let icon: String
    let trailing: String

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            IconChip(systemName: icon, tint: RadarTheme.blue, size: 34)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(RadarFont.display(24, .bold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(subtitle)
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
            Spacer()
            LoopOpsPill(text: trailing, color: RadarTheme.blue, icon: "checkmark.circle")
        }
        .padding(18)
        .researchPanel()
    }
}

private struct LoopOpsContractRow: View {
    let contract: LoopContract
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: contract.domain.systemImage, tint: contract.domain.tint, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(contract.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(contract.goal)
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
                Text("Review rule: \(contract.feedbackGate)")
                    .font(.system(size: 10.5))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)
            }
            Spacer()
            Text("v\(contract.version)")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
        }
        .padding(10)
        .quietRow(selected: selected, cornerRadius: 12)
    }
}

private struct LoopOpsLedgerRow: View {
    let ledger: RunLedgerRow
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: ledger.domain.systemImage, tint: ledger.domain.tint, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(ledger.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(ledger.finalAnswerPreview)
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
                Text("Review: \(loopOpsReviewDecisionDisplay(ledger.reviewDecision))")
                    .font(.system(size: 10.5))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            Spacer()
            LoopOpsPill(text: RuntimeStatusPresenter.label(ledger.status), color: ledger.domain.tint, icon: "clock")
        }
        .padding(10)
        .quietRow(selected: selected, cornerRadius: 12)
    }
}

enum LoopOpsReviewDecisionAction: CaseIterable, Identifiable {
    case reviewed
    case needsFollowUp
    case blocked

    var id: String { decisionValue }

    var title: String {
        switch self {
        case .reviewed:
            return "Reviewed"
        case .needsFollowUp:
            return "Needs follow-up"
        case .blocked:
            return "Blocked"
        }
    }

    var decisionValue: String {
        switch self {
        case .reviewed:
            return "reviewed"
        case .needsFollowUp:
            return "needs_follow_up"
        case .blocked:
            return "blocked"
        }
    }

    var icon: String {
        switch self {
        case .reviewed:
            return "checkmark.circle"
        case .needsFollowUp:
            return "arrow.triangle.branch"
        case .blocked:
            return "hand.raised"
        }
    }

    var tint: Color {
        switch self {
        case .reviewed:
            return RadarTheme.green
        case .needsFollowUp:
            return RadarTheme.gold
        case .blocked:
            return RadarTheme.red
        }
    }
}

private func loopOpsReviewDecisionDisplay(_ value: String) -> String {
    let normalized = value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "-", with: "_")
        .lowercased()

    switch normalized {
    case "", "pending":
        return "Pending"
    case "reviewed", "approved":
        return "Reviewed"
    case "needs_follow_up", "needsfollowup":
        return "Needs follow-up"
    case "blocked":
        return "Blocked"
    case "rejected":
        return "Rejected"
    default:
        return normalized
            .split(separator: "_")
            .map { $0.capitalized }
            .joined(separator: " ")
    }
}

private func loopOpsReviewDecisionTint(_ value: String) -> Color {
    let normalized = value
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "-", with: "_")
        .lowercased()

    switch normalized {
    case "reviewed", "approved":
        return RadarTheme.green
    case "needs_follow_up", "needsfollowup":
        return RadarTheme.gold
    case "blocked", "rejected":
        return RadarTheme.red
    default:
        return RadarTheme.blue
    }
}

private struct LoopOpsReviewDecisionPanel: View {
    let ledger: RunLedgerRow
    let packet: ReviewPacketViewModel
    let onDecision: (LoopOpsReviewDecisionAction) -> Void

    private let columns = [
        GridItem(.adaptive(minimum: 136), spacing: 8)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PanelHeader(
                icon: "checkmark.seal",
                title: "Review Tools",
                trailing: loopOpsReviewDecisionDisplay(packet.reviewDecision),
                tint: loopOpsReviewDecisionTint(packet.reviewDecision)
            )
            VStack(alignment: .leading, spacing: 5) {
                Text(ledger.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(packet.domainSummary)
                    .font(.system(size: 12))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(1)
            }

            Text(packet.finalAnswer)
                .font(.system(size: 12.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(4)
                .textSelection(.enabled)

            LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
                ForEach(LoopOpsReviewDecisionAction.allCases) { action in
                    Button {
                        onDecision(action)
                    } label: {
                        HStack(spacing: 7) {
                            Image(systemName: action.icon)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(action.tint)
                            Text(action.title)
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .quietRow(selected: packet.reviewDecision == action.decisionValue, cornerRadius: 10)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(LoopOpsInteractionID.reviewDecision(action.decisionValue))
                }
            }

            HStack(alignment: .top, spacing: 8) {
                LoopOpsReviewCount(label: "Claims", value: packet.claims.count, icon: "text.quote")
                LoopOpsReviewCount(label: "Gaps", value: packet.evidenceGaps.count, icon: "exclamationmark.triangle")
                LoopOpsReviewCount(label: "Blocked", value: packet.blockedActions.count, icon: "hand.raised")
            }

            if !packet.evidenceGaps.isEmpty {
                Text("Gaps: \(packet.evidenceGaps.prefix(2).joined(separator: " / "))")
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
            if !packet.reviewNotes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                LoopOpsKeyValue(label: "Review notes", value: packet.reviewNotes)
            }
            if !packet.eventHistory.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Review history")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                    ForEach(Array(packet.eventHistory.suffix(4).reversed())) { event in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(event.title)
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(RadarTheme.primaryText)
                                .lineLimit(1)
                            Text("\(event.actor) · \(event.occurredAt)")
                                .font(.system(size: 10.5))
                                .foregroundStyle(RadarTheme.mutedText)
                                .lineLimit(1)
                            if !event.detail.isEmpty {
                                Text(event.detail)
                                    .font(.system(size: 11))
                                    .foregroundStyle(RadarTheme.secondaryText)
                                    .lineLimit(2)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryReviewPacketHistory)
            }
            DisclosureGroup("Review details") {
                VStack(alignment: .leading, spacing: 8) {
                    LoopOpsKeyValue(label: "Claims", value: packet.claims.isEmpty ? "No claims recorded." : packet.claims.joined(separator: "\n"))
                    LoopOpsKeyValue(label: "Evidence gaps", value: packet.evidenceGaps.isEmpty ? "No gaps recorded." : packet.evidenceGaps.joined(separator: "\n"))
                    LoopOpsKeyValue(label: "Blocked actions", value: packet.blockedActions.isEmpty ? "No blocked action recorded." : packet.blockedActions.joined(separator: "\n"))
                    LoopOpsKeyValue(label: "Next questions", value: packet.nextQuestions.isEmpty ? "No next question recorded." : packet.nextQuestions.joined(separator: "\n"))
                    LoopOpsKeyValue(label: "Uncertainty", value: packet.uncertainty)
                }
                .padding(.top, 6)
            }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(RadarTheme.primaryText)
        }
        .accessibilityIdentifier(LoopOpsInteractionID.loopLibraryReviewPacket)
    }
}

private struct LoopOpsReviewCount: View {
    let label: String
    let value: Int
    let icon: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            Text("\(value)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(RadarTheme.primaryText)
            Text(label)
                .font(.system(size: 10.5))
                .foregroundStyle(RadarTheme.mutedText)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(RadarTheme.panelElevated)
        .clipShape(Capsule())
    }
}

private struct LoopOpsChatBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .assistant { Spacer(minLength: 24) }
            VStack(alignment: .leading, spacing: 4) {
                Text(message.role.rawValue.capitalized)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                Text(message.text)
                    .font(.system(size: 12.5))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(5)
            }
            .padding(10)
            .background(message.role == .user ? RadarTheme.panelElevated : RadarTheme.tintFaint)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            if message.role == .user { Spacer(minLength: 24) }
        }
    }
}

private struct LoopOpsKeyValue: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            Text(value)
                .font(.system(size: 12.5))
                .foregroundStyle(RadarTheme.primaryText)
                .lineLimit(4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct LoopOpsPill: View {
    let text: String
    let color: Color
    let icon: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
                .font(.system(size: 10.5, weight: .semibold))
            Text(text)
                .font(.system(size: 10.5, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(color.opacity(0.11))
        .clipShape(Capsule())
    }
}

private struct LoopOpsEmptyText: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: icon, tint: RadarTheme.mutedText, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(detail)
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
            }
            Spacer()
        }
        .padding(10)
        .quietRow(cornerRadius: 12)
    }
}

private struct LoopOpsInlineNotice: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(RadarTheme.gold)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(3)
            }
            Spacer(minLength: 0)
        }
        .padding(9)
        .background(RadarTheme.gold.opacity(0.09))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct LoopOpsEditorSection: View {
    let title: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            TextField(title, text: $text, axis: .vertical)
                .lineLimit(2...5)
                .loopOpsField()
        }
    }
}

private struct LoopOpsSkillPackageRow: View {
    let package: LoopOpsSkillPackage
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: package.kind == .skill ? "wand.and.stars" : "shippingbox", tint: package.selected ? RadarTheme.blue : RadarTheme.secondaryText, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(package.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    LoopOpsPill(text: package.kind.title, color: RadarTheme.secondaryText, icon: "tag")
                }
                Text(package.description)
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
                Text("\(package.domainLabel) · \(package.status)")
                    .font(.system(size: 10.5))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: package.selected ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(package.selected ? RadarTheme.green : RadarTheme.mutedText)
        }
        .padding(10)
        .quietRow(selected: selected, cornerRadius: 12)
    }
}

private struct LoopOpsSkillStackRow: View {
    let stack: LoopOpsSkillStack

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IconChip(systemName: "square.stack.3d.up", tint: RadarTheme.green, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(stack.name)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(RadarTheme.primaryText)
                    .lineLimit(1)
                Text(stack.summary)
                    .font(.system(size: 11.5))
                    .foregroundStyle(RadarTheme.secondaryText)
                    .lineLimit(2)
                Text("\(stack.bindings.count) steps")
                    .font(.system(size: 10.5))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            Spacer(minLength: 0)
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
        }
        .padding(10)
        .quietRow(cornerRadius: 12)
    }
}

private struct LoopOpsSkillPathList: View {
    let bindings: [LoopOpsSkillBinding]
    let title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            ForEach(LoopOpsSkillBinding.ordered(bindings)) { binding in
                HStack(spacing: 8) {
                    Text("\(binding.order + 1)")
                        .font(.system(size: 10.5, weight: .bold, design: .rounded))
                        .foregroundStyle(RadarTheme.mutedText)
                        .frame(width: 20, alignment: .leading)
                    Text(binding.title)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Spacer()
                    LoopOpsPill(text: binding.kind.title, color: RadarTheme.secondaryText, icon: "tag")
                }
                .padding(9)
                .quietRow(cornerRadius: 10)
            }
        }
    }
}

private struct LoopOpsSkillPathEditor: View {
    @Binding var bindings: [LoopOpsSkillBinding]
    let stacks: [LoopOpsSkillStack]
    let title: String
    let applyDrop: (String, String?) -> Void
    let onManualEdit: () -> Void
    @State private var targetedID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                Spacer()
                Text("\(bindings.count)")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            VStack(alignment: .leading, spacing: 7) {
                if bindings.isEmpty {
                    LoopOpsEmptyText(icon: "arrow.down.doc", title: "Drop skills here", detail: "Drag skills or stacks from the Skill OS Shelf into this execution path.")
                } else {
                    ForEach(LoopOpsSkillBinding.ordered(bindings)) { binding in
                        LoopOpsSkillPathEditorRow(
                            binding: binding,
                            isTargeted: targetedID == binding.dragID,
                            toggleEnabled: { toggleEnabled(binding) },
                            moveUp: { move(binding, by: -1) },
                            moveDown: { move(binding, by: 1) },
                            remove: { remove(binding) }
                        )
                        .onDrag { NSItemProvider(object: binding.dragPayload as NSString) }
                        .onDrop(of: [.text], isTargeted: targetedBinding(binding)) { providers in
                            loadDrop(providers, before: binding.dragID)
                        }
                    }
                }
            }
            .padding(8)
            .background(RadarTheme.panelElevated)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(RadarTheme.border, lineWidth: 1)
            )
            .onDrop(of: [.text], isTargeted: nil) { providers in
                loadDrop(providers, before: nil)
            }
            .accessibilityIdentifier(LoopOpsInteractionID.studioExecutionPath)
        }
    }

    private func targetedBinding(_ binding: LoopOpsSkillBinding) -> Binding<Bool> {
        Binding(
            get: { targetedID == binding.dragID },
            set: { targetedID = $0 ? binding.dragID : nil }
        )
    }

    private func loadDrop(_ providers: [NSItemProvider], before beforeID: String?) -> Bool {
        guard let provider = providers.first else { return false }
        provider.loadObject(ofClass: NSString.self) { object, _ in
            let payload = (object as? String) ?? (object as? NSString).map(String.init)
            guard let payload else { return }
            DispatchQueue.main.async {
                applyDrop(payload, beforeID)
            }
        }
        return true
    }

    private func move(_ binding: LoopOpsSkillBinding, by delta: Int) {
        var ordered = LoopOpsSkillBinding.ordered(bindings)
        guard let index = ordered.firstIndex(where: { $0.dragID == binding.dragID }) else { return }
        let target = min(max(0, index + delta), ordered.count - 1)
        guard target != index else { return }
        ordered.swapAt(index, target)
        bindings = LoopOpsSkillBinding.normalizeCurrentOrder(ordered)
        onManualEdit()
    }

    private func remove(_ binding: LoopOpsSkillBinding) {
        bindings.removeAll { $0.dragID == binding.dragID }
        bindings = LoopOpsSkillBinding.ordered(bindings)
        onManualEdit()
    }

    private func toggleEnabled(_ binding: LoopOpsSkillBinding) {
        var ordered = LoopOpsSkillBinding.ordered(bindings)
        guard let index = ordered.firstIndex(where: { $0.dragID == binding.dragID }) else { return }
        ordered[index].enabled.toggle()
        bindings = LoopOpsSkillBinding.normalizeCurrentOrder(ordered)
        onManualEdit()
    }
}

private struct LoopOpsSkillPathEditorRow: View {
    let binding: LoopOpsSkillBinding
    let isTargeted: Bool
    let toggleEnabled: () -> Void
    let moveUp: () -> Void
    let moveDown: () -> Void
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: "line.3.horizontal")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
            Text("\(binding.order + 1)")
                .font(.system(size: 10.5, weight: .bold, design: .rounded))
                .foregroundStyle(RadarTheme.mutedText)
                .frame(width: 20, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(binding.title)
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(binding.enabled ? RadarTheme.primaryText : RadarTheme.mutedText)
                    .lineLimit(1)
                Text("\(binding.kind.title) · \(binding.visibleSourceLabel)\(binding.enabled ? "" : " · Disabled")")
                    .font(.system(size: 10.5))
                    .foregroundStyle(RadarTheme.mutedText)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button(action: toggleEnabled) {
                Image(systemName: binding.enabled ? "checkmark.circle.fill" : "circle")
            }
            .buttonStyle(HoverIconButtonStyle(size: 26))
            .help(binding.enabled ? "Disable in this path" : "Enable in this path")
            Button(action: moveUp) { Image(systemName: "chevron.up") }
                .buttonStyle(HoverIconButtonStyle(size: 26))
                .accessibilityIdentifier(LoopOpsInteractionID.skillPathMoveUp(binding.dragID))
            Button(action: moveDown) { Image(systemName: "chevron.down") }
                .buttonStyle(HoverIconButtonStyle(size: 26))
                .accessibilityIdentifier(LoopOpsInteractionID.skillPathMoveDown(binding.dragID))
            Button(action: remove) { Image(systemName: "xmark") }
                .buttonStyle(HoverIconButtonStyle(size: 26))
                .accessibilityIdentifier(LoopOpsInteractionID.skillPathRemove(binding.dragID))
        }
        .padding(9)
        .opacity(binding.enabled ? 1 : 0.62)
        .quietRow(selected: isTargeted, cornerRadius: 10)
        .accessibilityIdentifier(LoopOpsInteractionID.skillPathRow(binding.dragID))
    }
}

struct LoopOpsToastStack: View {
    let toasts: [LoopOpsToast]
    let dismiss: (String) -> Void
    let perform: (String, LoopOpsToast.Action) -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(toasts) { toast in
                HStack(alignment: .top, spacing: 9) {
                    Image(systemName: icon(for: toast.tone))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(color(for: toast.tone))
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(toast.title)
                            .font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
                        Text(toast.detail)
                            .font(.system(size: 11.5))
                            .foregroundStyle(RadarTheme.secondaryText)
                            .lineLimit(2)
                        if let action = toast.action {
                            Button(action.title) {
                                perform(toast.id, action)
                            }
                            .buttonStyle(ResearchSecondaryButtonStyle())
                            .padding(.top, 3)
                        }
                    }
                    Button {
                        dismiss(toast.id)
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(HoverIconButtonStyle(size: 22))
                }
                .padding(10)
                .frame(width: 280, alignment: .leading)
                .background(RadarTheme.panel)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(RadarTheme.border, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .accessibilityIdentifier(LoopOpsInteractionID.knowledgeToastStack)
    }

    private func icon(for tone: LoopOpsToast.Tone) -> String {
        switch tone {
        case .info: return "info.circle"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    private func color(for tone: LoopOpsToast.Tone) -> Color {
        switch tone {
        case .info: return RadarTheme.blue
        case .success: return RadarTheme.green
        case .warning: return RadarTheme.gold
        case .error: return RadarTheme.red
        }
    }
}

private struct FlowLayout<Content: View>: View {
    let spacing: CGFloat
    @ViewBuilder var content: () -> Content

    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 120), spacing: spacing)],
            alignment: .leading,
            spacing: spacing,
            content: content
        )
    }
}

private struct LoopOpsQuickActionChip: View {
    let action: LoopOpsQuickAction
    let perform: () -> Void

    var body: some View {
        Button(action: perform) {
            HStack(spacing: 6) {
                Image(systemName: action.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                Text(action.title)
                    .font(.system(size: 11.5, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundStyle(RadarTheme.primaryText)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RadarTheme.panelElevated)
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
        .help(action.prompt)
    }
}

private struct LoopOpsChatControlChip: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let active: Bool

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: systemImage)
                .font(.system(size: 10.5, weight: .semibold))
                .frame(width: 13)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 11.5, weight: .semibold))
                    .lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(active ? RadarTheme.blue.opacity(0.82) : RadarTheme.mutedText)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(active ? RadarTheme.blue : RadarTheme.primaryText)
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(active ? RadarTheme.blue.opacity(0.12) : RadarTheme.panelElevated)
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(active ? RadarTheme.blue.opacity(0.38) : RadarTheme.borderSoft, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

private struct LoopOpsAttachmentChip: View {
    let title: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage)
                .font(.system(size: 10.5, weight: .semibold))
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
        }
        .foregroundStyle(RadarTheme.mutedText)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RadarTheme.tintFaint)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct LoopOpsListingSection<Content: View>: View {
    let title: String
    let icon: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.blue)
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
            }
            content
        }
        .padding(10)
        .background(RadarTheme.panelElevated.opacity(0.62))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft, lineWidth: 1)
        )
    }
}

private struct LoopOpsTemplateListingRow: View {
    let listing: LoopOpsTemplateListing
    let selected: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                IconChip(systemName: listing.domain.systemImage, tint: listing.domain.tint, size: 30)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(listing.title)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(RadarTheme.primaryText)
                            .lineLimit(1)
                        LoopOpsPill(text: listing.categoryLabel, color: listing.domain.tint, icon: "folder")
                    }
                    Text(listing.summary)
                        .font(.system(size: 11.5))
                        .foregroundStyle(RadarTheme.secondaryText)
                        .lineLimit(2)
                    HStack(spacing: 5) {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(RadarTheme.mutedText)
                        Text(listing.skillPath.isEmpty ? "No execution path selected" : listing.skillPath)
                            .font(.system(size: 10.5))
                            .foregroundStyle(RadarTheme.mutedText)
                            .lineLimit(1)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            LoopOpsPill(text: listing.templateTypeLabel, color: RadarTheme.secondaryText, icon: "square.stack.3d.up")
                .frame(width: 110, alignment: .leading)
            LoopOpsPill(text: listing.accessLabel, color: listing.isInstallable ? RadarTheme.blue : RadarTheme.secondaryText, icon: listing.isInstallable ? "square.and.arrow.down" : "checkmark.seal")
                .frame(width: 108, alignment: .leading)
            Text(listing.updatedLabel)
                .font(.system(size: 11.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .frame(width: 104, alignment: .leading)
            LoopOpsPill(text: listing.readinessLabel, color: listing.contract.isRunnable ? RadarTheme.green : RadarTheme.gold, icon: listing.contract.isRunnable ? "checkmark.circle" : "exclamationmark.triangle")
                .frame(width: 118, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .quietRow(selected: selected, cornerRadius: 10)
    }
}

private struct LoopOpsLibrarySummaryStrip: View {
    let shownCount: Int
    let totalCount: Int
    let readyCount: Int
    let setupCount: Int
    let installedCount: Int

    var body: some View {
        HStack(spacing: 8) {
            LoopOpsPill(text: "\(shownCount) of \(totalCount) visible", color: RadarTheme.secondaryText, icon: "tablecells")
            LoopOpsPill(text: "\(readyCount) ready", color: RadarTheme.green, icon: "checkmark.circle")
            LoopOpsPill(text: "\(setupCount) setup", color: setupCount == 0 ? RadarTheme.secondaryText : RadarTheme.gold, icon: "wrench.and.screwdriver")
            LoopOpsPill(text: "\(installedCount) in workspace", color: RadarTheme.blue, icon: "tray.full")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RadarTheme.panelElevated.opacity(0.44))
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(RadarTheme.borderSoft.opacity(0.75), lineWidth: 1)
        )
    }
}

private struct LoopOpsToolLogHeaderRow: View {
    private let columns = ["Status", "Tool", "Input", "Time", "User", "Cost", "Duration"]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                Text(column)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(RadarTheme.mutedText)
                    .frame(maxWidth: index == 1 ? .infinity : nil, alignment: .leading)
                    .frame(width: index == 1 ? nil : columnWidth(index), alignment: .leading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RadarTheme.panelElevated.opacity(0.72))
    }

    private func columnWidth(_ index: Int) -> CGFloat {
        switch index {
        case 0: return 68
        case 2: return 82
        case 3: return 76
        case 4: return 68
        case 5: return 76
        default: return 70
        }
    }
}

private struct LoopOpsToolLogRow: View {
    let log: LoopOpsToolLog
    var linkedRunTitle: String? = nil
    var savedToKnowledge = false
    var saveToKnowledge: (() -> Void)? = nil
    var attachToRun: (() -> Void)? = nil
    var openReviewChat: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            StatusDot(color: statusColor, pulsing: false)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(log.publicTitle)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(RadarTheme.primaryText)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text(log.createdAt.formatted(date: .abbreviated, time: .shortened))
                        .font(.system(size: 10.5))
                        .foregroundStyle(RadarTheme.mutedText)
                        .lineLimit(1)
                }
                HStack(spacing: 6) {
                    LoopOpsPill(text: log.publicStatusLabel, color: statusColor, icon: statusIcon)
                    LoopOpsPill(text: log.durationLabel, color: RadarTheme.secondaryText, icon: "timer")
                    LoopOpsPill(text: log.publicReviewState, color: RadarTheme.blue, icon: "checkmark.seal")
                    LoopOpsPill(text: log.publicSourceLabel, color: RadarTheme.secondaryText, icon: "square.stack")
                    LoopOpsPill(text: log.resolvedUserLabel, color: RadarTheme.secondaryText, icon: "person.crop.circle")
                    LoopOpsPill(text: log.resolvedCostLabel, color: RadarTheme.secondaryText, icon: "creditcard")
                    if let linkedRunTitle {
                        LoopOpsPill(text: linkedRunTitle, color: RadarTheme.green, icon: "link")
                    }
                    if savedToKnowledge {
                        LoopOpsPill(text: "Knowledge", color: RadarTheme.gold, icon: "tray.full")
                    }
                }
                LoopOpsToolLogDetailLine(label: "Input", value: log.publicInputSummary)
                LoopOpsToolLogDetailLine(
                    label: log.errorSummary?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? "Error" : "Output",
                    value: log.publicOutputOrErrorSummary
                )
                if saveToKnowledge != nil || attachToRun != nil || openReviewChat != nil {
                    HStack(spacing: 7) {
                        if let saveToKnowledge {
                            Button(action: saveToKnowledge) {
                                Label(savedToKnowledge ? "Saved" : "Save to Knowledge", systemImage: savedToKnowledge ? "checkmark.circle" : "tray.and.arrow.down")
                            }
                            .disabled(savedToKnowledge)
                            .buttonStyle(ResearchSecondaryButtonStyle())
                        }
                        if let attachToRun {
                            Button(action: attachToRun) {
                                Label(log.runID == nil ? "Attach to Run" : "Update Run Link", systemImage: "paperclip")
                            }
                            .buttonStyle(ResearchSecondaryButtonStyle())
                        }
                        if let openReviewChat {
                            Button(action: openReviewChat) {
                                Label("Open Review Chat", systemImage: "bubble.left.and.text.bubble.right")
                            }
                            .buttonStyle(ResearchSecondaryButtonStyle())
                            .accessibilityIdentifier(LoopOpsInteractionID.skillOSToolLogReviewChat)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 9)
        .quietRow(cornerRadius: 10)
    }

    private var statusColor: Color {
        switch log.canonicalStatus {
        case .succeeded:
            return RadarTheme.green
        case .running:
            return RadarTheme.green
        case .failed:
            return RadarTheme.red
        case .blocked:
            return RadarTheme.gold
        case .submitting, .waiting, .validated, .draft:
            return RadarTheme.blue
        }
    }

    private var statusIcon: String {
        switch log.canonicalStatus {
        case .succeeded:
            return "checkmark.circle"
        case .running:
            return "link.circle"
        case .failed:
            return "xmark.circle"
        case .blocked:
            return "exclamationmark.triangle"
        case .submitting:
            return "clock.arrow.circlepath"
        case .waiting:
            return "clock"
        case .validated:
            return "checkmark.seal"
        case .draft:
            return "square.and.pencil"
        }
    }
}

private struct LoopOpsToolLogDetailLine: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Text(label)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(RadarTheme.mutedText)
                .frame(width: 42, alignment: .leading)
            Text(value)
                .font(.system(size: 11.5))
                .foregroundStyle(RadarTheme.secondaryText)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private extension View {
    func loopOpsField() -> some View {
        self
            .textFieldStyle(.plain)
            .font(.system(size: 12.5))
            .padding(9)
            .background(RadarTheme.panelElevated)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(RadarTheme.border, lineWidth: 1)
            )
    }
}

private extension LoopOpsSkillBinding {
    var dragPayload: String {
        [
            "loopops-skill",
            kind.rawValue,
            id,
            title.replacingOccurrences(of: "|", with: " "),
            source
        ].joined(separator: "|")
    }

    var visibleSourceLabel: String {
        switch source {
        case "runtime-fallback", "template":
            return "Default path"
        case "selected":
            return "Current stack"
        case "single-skill":
            return "Saved stack"
        case "local-tool-draft":
            return "Local draft"
        case "tool-page":
            return "Tool page"
        case "builder-chat":
            return "Builder Chat"
        case "new-loop":
            return "New loop"
        default:
            let label = source
                .replacingOccurrences(of: "-", with: " ")
                .replacingOccurrences(of: "_", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return label.isEmpty ? "Workspace" : label.capitalized
        }
    }
}

private extension String {
    func linesForLoopOps() -> [String] {
        split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    var normalizedLoopOpsViewToken: String {
        trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}
