import CoreKit
import DesignSystem
import SwiftUI

/// The agent of one project: its instructions (AGENT.md), what Semp does that they do not agree with, the tools it may
/// use, its automatic tasks and its latest runs.
struct SempProjectAgentScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SempProjectAgentViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SempProjectAgentViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("semp.agent.title", bundle: .module))
            .inlineNavigationTitle()
            .toolbar { PlainToolbarItem(placement: .primaryAction) { saveLabel } }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(SempIdentifiers.projectAgent)
            .alert(
                Text("semp.agent.changeFailed", bundle: .module),
                isPresented: changeFailed,
                actions: {
                    Button { viewModel.send(.dismissFailure) } label: { Text("semp.action.dismiss", bundle: .module) }
                }
            )
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SempProjectAgentScreen {

    var state: SempProjectAgentState {
        viewModel.state
    }

    var changeFailed: Binding<Bool> {
        Binding(get: { state.changeFailed }, set: { _ in viewModel.send(.dismissFailure) })
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.sempMessage(for: failure)), retry: viewModel.retry))
        case .ready:
            form
        }
    }

    var form: some View {
        List {
            Section { heading }.listRowBackground(Color.clear)
            if state.partialFailure {
                Section {
                    Label {
                        Text("semp.agent.partial", bundle: .module)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                    }
                        .foregroundStyle(Theme.Colors.sempWaiting)
                    Button { viewModel.send(.retry) } label: { Text("semp.action.retry", bundle: .module) }
                }
            }
            if let finding = state.finding { Section { drift(finding) } }
            Section {
                ForEach(SempSection.allCases, id: \.self) { section in
                    SempSectionEditor(section: section, text: state.sections.text(of: section)) {
                        viewModel.send(.saveSection(section, text: $0))
                    }
                }
            } header: {
                header("semp.agent.instructions", detail: "AGENT.md")
            }
            Section {
                ForEach(state.servers) { server in serverRows(server) }
            } header: {
                header("semp.agent.tools", detail: toolCount)
            } footer: {
                Text("semp.agent.tools.footer", bundle: .module)
            }
            Section {
                ForEach(state.tasks) { task in taskRow(task) }
            } header: {
                Text("semp.agent.tasks", bundle: .module)
            } footer: {
                Text("semp.agent.tasks.footer", bundle: .module)
            }
            Section {
                ForEach(state.runs) { run in runRow(run) }
            } header: {
                Text("semp.agent.runs", bundle: .module)
            }
        }
        .groupedListStyle()
    }

    var heading: some View {
        HStack(spacing: 12) {
            Image(systemName: "sparkles")
                .font(.title3)
                .foregroundStyle(.white)
                .frame(width: 44, height: 44)
                .background(Theme.Colors.brand.opacity(0.85), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 2) {
                Text("semp.agent.heading", bundle: .module).font(.title3.weight(.semibold))
                if let name = state.projectName {
                    Text(name).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
    }

    func header(_ title: LocalizedStringKey, detail: String) -> some View {
        HStack {
            Text(title, bundle: .module)
            Spacer()
            Text(detail).textCase(nil)
        }
    }

    var toolCount: String {
        let all = state.servers.flatMap(\.tools)
        return String(
            format: String(localized: "semp.agent.tools.count", bundle: .module),
            locale: .current,
            all.filter(\.granted).count,
            all.count
        )
    }

    @ViewBuilder var saveLabel: some View {
        switch state.saveState {
        case .idle: EmptyView()
        case .saving:
            Text("semp.agent.save.saving", bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.sempWaiting)
        case .saved: Text("semp.agent.save.saved", bundle: .module).font(.footnote).foregroundStyle(.secondary)
        case .failed:
            Button { viewModel.send(.retrySave) } label: { Text("semp.agent.save.failed", bundle: .module) }
                .foregroundStyle(Theme.Colors.destructive)
        case .conflict:
            Text("semp.agent.save.conflict", bundle: .module).font(.footnote).foregroundStyle(Theme.Colors.sempWaiting)
        }
    }

    func drift(_ finding: SempFinding) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label {
                Text("semp.agent.drift.title", bundle: .module).font(.subheadline.weight(.semibold))
            } icon: {
                Circle()
                    .fill(finding.blocking ? Theme.Colors.destructive : Theme.Colors.sempWaiting)
                    .frame(width: 8, height: 8)
            }
            Text(finding.claim).font(.footnote).foregroundStyle(.secondary)
            HStack {
                if finding.canAllow {
                    Button { viewModel.send(.resolveDrift(.allow)) } label: {
                        Text("semp.agent.drift.allow", bundle: .module)
                    }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier(SempIdentifiers.driftAllow)
                }
                if finding.canForbid {
                    Button { viewModel.send(.resolveDrift(.forbid)) } label: {
                        Text("semp.agent.drift.forbid", bundle: .module)
                    }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier(SempIdentifiers.driftForbid)
                }
                Button { viewModel.send(.resolveDrift(.dismiss)) } label: {
                    Text("semp.agent.drift.dismiss", bundle: .module)
                }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier(SempIdentifiers.driftDismiss)
            }
            .controlSize(.small)
        }
    }

    @ViewBuilder
    func serverRows(_ server: SempToolServer) -> some View {
        HStack {
            Text(server.name).font(.subheadline.weight(.semibold))
            Spacer()
            Text(server.online ? "semp.agent.server.online" : "semp.agent.server.offline", bundle: .module)
                .font(.caption)
                .foregroundStyle(server.online ? Theme.Colors.sempSuccess : Theme.Colors.secondaryText)
        }
        ForEach(server.tools) { tool in
            Toggle(isOn: toolBinding(tool)) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(tool.label)
                    if tool.requiresApproval {
                        Text("semp.agent.tool.asks", bundle: .module).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .opacity(server.online ? 1 : 0.55)
            .accessibilityIdentifier(SempIdentifiers.toolPrefix + tool.registrationId)
        }
    }

    func toolBinding(_ tool: SempToolRow) -> Binding<Bool> {
        Binding(
            get: { tool.granted },
            set: { viewModel.send(.setTool(registrationId: tool.registrationId, granted: $0)) }
        )
    }

    func taskRow(_ task: SempTaskRow) -> some View {
        HStack {
            Button { viewModel.send(.openTask(taskId: task.id)) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.name)
                    Text(task.ruleLabel).font(.caption).foregroundStyle(.secondary)
                    Text(lastText(task))
                        .font(.caption)
                        .foregroundStyle(task.lastFailed ? Theme.Colors.destructive : .secondary)
                }
            }
            .buttonStyle(.plain)
            .disabled(task.threadId == nil)
            Spacer()
            Toggle(
                isOn: Binding(
                    get: { task.enabled },
                    set: { viewModel.send(.setTask(taskId: task.id, enabled: $0)) }
                )
            ) {
                Text(task.name)
            }
            .labelsHidden()
            .accessibilityIdentifier(SempIdentifiers.taskPrefix + task.id)
        }
    }

    func lastText(_ task: SempTaskRow) -> String {
        guard let last = task.lastAt, let ago = SempTime.started(last) else {
            return String(localized: "semp.agent.task.never", bundle: .module)
        }
        if task.lastFailed {
            return String(
                format: String(localized: "semp.agent.task.failed", bundle: .module),
                locale: .current,
                ago,
                task.lastErrorSummary ?? ""
            )
        }
        if task.lastWaiting {
            return String(format: String(localized: "semp.agent.task.waiting", bundle: .module), locale: .current, ago)
        }
        return String(format: String(localized: "semp.agent.task.ok", bundle: .module), locale: .current, ago)
    }

    func runRow(_ run: SempAgentRunRow) -> some View {
        Button { viewModel.send(.openRun(rowId: run.id)) } label: {
            HStack(spacing: 12) {
                Image(systemName: icon(run.trigger))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(color(run), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(run.title)
                    Text(meta(run))
                        .font(.caption)
                        .foregroundStyle(run.display == .error ? Theme.Colors.destructive : .secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(.tertiary)
            }
        }
        .listRowButton()
        .dropTarget(SempTarget(kind: .run, title: run.title, meta: meta(run), runId: run.runId))
        .accessibilityIdentifier(SempIdentifiers.runRowPrefix + run.id)
    }

    func icon(_ trigger: SempRunTriggerKind) -> String {
        switch trigger {
        case .user: "bubble.left"
        case .tick: "clock"
        case .mcp: "plus"
        case .supervisor: "gearshape"
        }
    }

    func color(_ run: SempAgentRunRow) -> Color {
        switch run.display {
        case .error: Theme.Colors.destructive
        case .waitingApproval: Theme.Colors.sempWaiting
        case .running, .done: run.trigger == .tick ? Theme.Colors.SempKind.area : Theme.Colors.brand
        }
    }

    func meta(_ run: SempAgentRunRow) -> String {
        var parts: [String] = []
        parts.append(SempTime.started(run.startedAt) ?? run.startedAt)
        if let duration = run.durationMs { parts.append(SempTime.duration(milliseconds: duration)) }
        if run.costUsd > 0 { parts.append(SempTime.cost(run.costUsd)) }
        if run.display == .waitingApproval { parts.append(String(localized: "semp.run.waiting", bundle: .module)) }
        if run.display == .error, let summary = run.errorSummary { parts.append(summary) }
        return parts.joined(separator: " · ")
    }
}

#Preview {
    NavigationStack {
        SempProjectAgentScreen(
            viewModel: SempProjectAgentViewModel(
                model: ScriptedSempProjectAgentScreenModel(
                    state: SempProjectAgentState(
                        phase: .ready,
                        projectName: "Semprec iOS",
                        sections: SempSections(
                            purpose: "Pomáhat s vývojem.",
                            allowed: "- číst úkoly",
                            notAllowed: "",
                            general: ""
                        )
                    )
                ),
                router: PreviewSempRouter()
            )
        )
    }
}
