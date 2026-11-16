import CoreKit
import DesignSystem
import SwiftUI

/// One run of the agent: how it started and went, what it did step by step, and what it cost. A run that is still going
/// is read again by the Kotlin ViewModel until it ends.
struct SempRunScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SempRunViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SempRunViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("semp.run.title", bundle: .module))
            .inlineNavigationTitle()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(SempIdentifiers.run)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SempRunScreen {

    var state: SempRunState {
        viewModel.state
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.sempMessage(for: failure)), retry: viewModel.retry))
        case .ready:
            if let run = state.run { loaded(run) } else { StatusView(.loading) }
        }
    }

    func loaded(_ run: SempRunView) -> some View {
        List {
            Section { header(run) }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            Section { facts(run) }
            if let summary = run.errorSummary {
                Section {
                    Text(summary).foregroundStyle(Theme.Colors.destructive)
                    if run.canRetry { retryButton }
                    if state.retryFailed {
                        Text("semp.run.retryFailed", bundle: .module).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            Section { steps } header: { Text("semp.run.progress", bundle: .module) }
            Section {
                ForEach(run.usage) { usage in usageRow(usage) }
                HStack {
                    Text("semp.run.total", bundle: .module)
                    Spacer()
                    Text(SempTime.cost(run.totalCostUsd) + (run.costIsEstimate ? " *" : ""))
                }
                .font(.subheadline.weight(.semibold))
            } header: {
                Text("semp.run.usage", bundle: .module)
            } footer: {
                Text(run.costIsEstimate ? "semp.run.usage.estimate" : "semp.run.usage.footer", bundle: .module)
            }
        }
        .groupedListStyle()
    }

    func header(_ run: SempRunView) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            statusPill(run.display)
            Text(run.title).font(.title3.weight(.semibold))
            Text(subtitle(run)).font(.footnote).foregroundStyle(.secondary)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    func statusPill(_ display: SempRunDisplay) -> some View {
        let color = color(display)
        return HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            statusText(display).font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
    }

    func facts(_ run: SempRunView) -> some View {
        Group {
            factRow("semp.run.fact.trigger", triggerText(run.trigger))
            if let project = run.projectName { factRow("semp.run.fact.project", project) }
            if let started = SempTime.started(run.startedAt) { factRow("semp.run.fact.started", started) }
            if let duration = run.durationMs { factRow("semp.run.fact.duration", SempTime.duration(milliseconds: duration)) }
            approvalsRow(run)
        }
    }

    func factRow(_ label: LocalizedStringKey, _ value: String) -> some View {
        HStack {
            Text(label, bundle: .module).foregroundStyle(.secondary)
            Spacer()
            Text(value)
        }
    }

    @ViewBuilder
    func approvalsRow(_ run: SempRunView) -> some View {
        if run.approvalCount == 0 {
            factRow("semp.run.fact.approvals", String(localized: "semp.run.approvals.none", bundle: .module))
        } else {
            Button { viewModel.send(.openApprovals) } label: {
                HStack {
                    Text("semp.run.fact.approvals", bundle: .module).foregroundStyle(.secondary)
                    Spacer()
                    Text(approvalsText(run))
                    Image(systemName: "chevron.right").imageScale(.small).foregroundStyle(.tertiary)
                }
            }
            .listRowButton()
            .accessibilityIdentifier(SempIdentifiers.runApprovals)
        }
    }

    var retryButton: some View {
        Button { viewModel.send(.retryRun) } label: {
            if state.retrying { ProgressView() } else { Text("semp.run.retry", bundle: .module) }
        }
        .disabled(state.retrying)
        .accessibilityIdentifier(SempIdentifiers.runRetry)
    }

    var steps: some View {
        Group {
            switch state.stepsPhase {
            case .none, .loading:
                ProgressView()
            case .error:
                Text("semp.run.stepsFailed", bundle: .module).foregroundStyle(.secondary)
            case .ready:
                ForEach(state.steps) { step in stepRow(step) }
                if state.historyTruncated {
                    Text("semp.run.truncated", bundle: .module).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }

    func stepRow(_ step: SempRunStepRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(step.title).font(.subheadline.weight(.semibold))
                Spacer()
                Text(SempTime.clock(step.at) ?? "").font(.caption).foregroundStyle(.secondary)
            }
            if let summary = step.summary { Text(summary).font(.footnote).foregroundStyle(.secondary) }
            if let duration = step.durationMs {
                Text(SempTime.duration(milliseconds: duration)).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    func usageRow(_ usage: SempUsageRow) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(usage.modelName)
                Text(
                    String(
                        format: String(localized: "semp.run.usage.detail", bundle: .module),
                        locale: .current,
                        usage.calls,
                        usage.inputTokens.formatted(),
                        usage.outputTokens.formatted()
                    )
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Text(SempTime.cost(usage.costUsd))
        }
    }

    func subtitle(_ run: SempRunView) -> String {
        var parts = [triggerText(run.trigger)]
        if let started = SempTime.started(run.startedAt) { parts.append(started) }
        if let duration = run.durationMs { parts.append(SempTime.duration(milliseconds: duration)) }
        return parts.joined(separator: " · ")
    }

    func approvalsText(_ run: SempRunView) -> String {
        if run.pendingApprovalCount == 0 {
            return String(format: String(localized: "semp.run.approvals.done", bundle: .module), locale: .current, run.approvalCount)
        }
        return String(
            format: String(localized: "semp.run.approvals.waiting", bundle: .module),
            locale: .current,
            run.approvalCount,
            run.pendingApprovalCount
        )
    }

    func triggerText(_ trigger: SempRunTriggerKind) -> String {
        switch trigger {
        case .user: String(localized: "semp.run.trigger.user", bundle: .module)
        case .tick: String(localized: "semp.run.trigger.tick", bundle: .module)
        case .mcp: String(localized: "semp.run.trigger.mcp", bundle: .module)
        case .supervisor: String(localized: "semp.run.trigger.supervisor", bundle: .module)
        }
    }

    func statusText(_ display: SempRunDisplay) -> Text {
        switch display {
        case .running: Text("semp.run.status.running", bundle: .module)
        case .done: Text("semp.run.status.done", bundle: .module)
        case .waitingApproval: Text("semp.run.status.waiting", bundle: .module)
        case .error: Text("semp.run.status.error", bundle: .module)
        }
    }

    func color(_ display: SempRunDisplay) -> Color {
        switch display {
        case .running: Theme.Colors.accent
        case .done: Theme.Colors.sempSuccess
        case .waitingApproval: Theme.Colors.sempWaiting
        case .error: Theme.Colors.destructive
        }
    }
}

#Preview {
    NavigationStack {
        SempRunScreen(
            viewModel: SempRunViewModel(
                model: ScriptedSempRunScreenModel(
                    state: SempRunState(
                        phase: .ready,
                        run: SempRunView(
                            id: "r1",
                            title: "Přesuň fakturu na zítra ráno",
                            display: .done,
                            trigger: .user,
                            threadId: "t1",
                            projectName: "Semp",
                            startedAt: "2026-10-21T13:24:02.000Z",
                            durationMs: 4_100,
                            approvalCount: 0,
                            pendingApprovalCount: 0,
                            errorSummary: nil,
                            canRetry: false,
                            totalCostUsd: 0.021,
                            costIsEstimate: false,
                            usage: []
                        ),
                        stepsPhase: .ready
                    )
                ),
                router: PreviewSempRouter()
            )
        )
    }
}
