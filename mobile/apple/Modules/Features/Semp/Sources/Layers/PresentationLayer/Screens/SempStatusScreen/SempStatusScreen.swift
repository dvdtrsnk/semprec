import CoreKit
import DesignSystem
import SwiftUI

/// The health of Semp: what needs attention, with the one fix and the one link each problem has, the services Semp
/// depends on, and what was solved in the last days.
struct SempStatusScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SempStatusViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> SempStatusViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("semp.status.title", bundle: .module))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(SempIdentifiers.status)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension SempStatusScreen {

    var state: SempStatusState {
        viewModel.state
    }

    @ViewBuilder var content: some View {
        switch state.phase {
        case .loading:
            StatusView(.loading)
        case .failure(let failure):
            StatusView(.failure(message: Text(FailureKind.sempMessage(for: failure)), retry: viewModel.retry))
        case .ready:
            list
        }
    }

    var list: some View {
        List {
            Section { hero }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            if !state.issues.isEmpty {
                Section {
                    ForEach(state.issues) { issue in issueCard(issue).listRowInsets(EdgeInsets()) }
                } header: {
                    Text("semp.status.attention", bundle: .module)
                }
            }
            Section { ForEach(state.services) { service in serviceRow(service) } } header: {
                Text("semp.status.services", bundle: .module)
            }
            Section {
                DisclosureGroup(isExpanded: historyOpen) {
                    ForEach(state.resolved) { row in resolvedRow(row) }
                } label: {
                    HStack {
                        Text("semp.status.resolved", bundle: .module)
                        Text(String(state.resolved.count)).foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier(SempIdentifiers.history7)
            }
        }
        .groupedListStyle()
    }

    var historyOpen: Binding<Bool> {
        Binding(get: { state.historyOpen }, set: { _ in viewModel.send(.toggleHistory) })
    }

    var hero: some View {
        let healthy = state.issues.isEmpty
        return HStack(spacing: 12) {
            Image(systemName: healthy ? "checkmark" : "exclamationmark.triangle.fill")
                .font(.title2.weight(.semibold))
                .foregroundStyle(healthy ? Theme.Colors.sempSuccess : Theme.Colors.sempWaiting)
                .frame(width: 44, height: 44)
                .background(
                    (healthy ? Theme.Colors.sempSuccess : Theme.Colors.sempWaiting).opacity(0.16),
                    in: Circle()
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(healthy ? "semp.status.hero.ok" : "semp.status.hero.issues", bundle: .module)
                    .font(.headline)
                if !healthy {
                    Text(
                        String(
                            format: String(localized: "semp.status.hero.count", bundle: .module),
                            locale: .current,
                            state.issues.count
                        )
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                } else {
                    Text("semp.status.hero.ok.sub", bundle: .module).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .padding(Theme.Spacing.medium)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 22))
        .padding(.horizontal, Theme.Spacing.medium)
    }

    func issueCard(_ issue: SempIssue) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: icon(issue.category))
                    .foregroundStyle(issue.critical ? Theme.Colors.destructive : Theme.Colors.sempWaiting)
                    .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 4) {
                    Text(issue.title).font(.subheadline.weight(.semibold))
                    Text(issue.text).font(.footnote).foregroundStyle(.secondary)
                    if let since = issue.since, let when = SempTime.started(since) {
                        Text(sinceText(when))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if issue.fixFailed {
                        Text("semp.status.fixFailed", bundle: .module)
                            .font(.footnote)
                            .foregroundStyle(Theme.Colors.destructive)
                    }
                }
            }
            HStack {
                if let fix = issue.fix { fixButton(issue, fix) }
                if let link = issue.link {
                    Button { viewModel.send(.open(issueId: issue.id)) } label: { linkLabel(link) }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier(SempIdentifiers.issueLink)
                }
            }
            .controlSize(.regular)
        }
        .padding(Theme.Spacing.medium)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(SempIdentifiers.issuePrefix + issue.id)
    }

    func fixButton(_ issue: SempIssue, _ fix: SempIssueFix) -> some View {
        Button { viewModel.send(.fix(issueId: issue.id)) } label: {
            if issue.busy {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("semp.status.busy", bundle: .module)
                }
            } else {
                fixLabel(fix)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(issue.busy)
        .accessibilityIdentifier(SempIdentifiers.issueFix)
    }

    func serviceRow(_ service: SempServiceRow) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(service.name)
                if let detail = detail(service) { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            HStack(spacing: 6) {
                Circle()
                    .fill(service.failingSince == nil ? Theme.Colors.sempSuccess : Theme.Colors.destructive)
                    .frame(width: 8, height: 8)
                (service.failingSince == nil
                    ? Text("semp.status.service.ok", bundle: .module)
                    : Text("semp.status.service.error", bundle: .module))
                    .font(.subheadline)
            }
        }
        .accessibilityElement(children: .combine)
    }

    func sinceText(_ when: String) -> String {
        String(format: String(localized: "semp.status.since", bundle: .module), locale: .current, when)
    }

    func resolvedRow(_ row: SempResolvedRow) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.Colors.sempSuccess)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title).font(.subheadline)
                if let when = SempTime.started(row.resolvedAt) {
                    Text(when).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    func detail(_ service: SempServiceRow) -> String? {
        if let failing = service.failingSince, let when = SempTime.started(failing) {
            return String(format: String(localized: "semp.status.since", bundle: .module), locale: .current, when)
        }
        guard let last = service.lastActivityAt, let ago = SempTime.ago(last) else { return nil }
        return String(format: String(localized: "semp.status.lastActivity", bundle: .module), locale: .current, ago)
    }

    func icon(_ category: String) -> String {
        switch category {
        case "mail": "envelope"
        case "agents": "bubble.left"
        case "guidance": "doc.text"
        case "automation": "gearshape.2"
        case "transcription": "waveform"
        case "backup": "externaldrive"
        default: "exclamationmark.circle"
        }
    }

    func fixLabel(_ fix: SempIssueFix) -> Text {
        switch fix {
        case .retry: Text("semp.status.fix.retry", bundle: .module)
        case .disableAutomation: Text("semp.status.fix.disable", bundle: .module)
        }
    }

    func linkLabel(_ link: SempIssueLink) -> Text {
        switch link {
        case .chat: Text("semp.status.link.chat", bundle: .module)
        case .thread: Text("semp.status.link.thread", bundle: .module)
        case .project: Text("semp.status.link.project", bundle: .module)
        }
    }
}

#Preview {
    NavigationStack {
        SempStatusScreen(
            viewModel: SempStatusViewModel(
                model: ScriptedSempStatusScreenModel(
                    state: SempStatusState(
                        phase: .ready,
                        issues: [
                            SempIssue(
                                id: "p1",
                                category: "mail",
                                critical: true,
                                title: "Pošta Gmail se nesynchronizuje",
                                text: "Přihlášení vypršelo.",
                                since: "2026-10-21T07:12:00.000Z",
                                mergedCount: 4,
                                projectName: nil,
                                fix: .retry,
                                link: .chat,
                                busy: false,
                                fixFailed: false
                            )
                        ],
                        services: [
                            SempServiceRow(key: "agents", name: "Semp a agenti", failingSince: nil, lastActivityAt: nil)
                        ]
                    )
                ),
                router: PreviewSempRouter()
            )
        )
    }
}
