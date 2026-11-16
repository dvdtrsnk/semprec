import CoreKit
import DesignSystem
import SwiftUI

/// One area: its name and icon, what is coming up in it, what is connected to it, and the setting that hides it from
/// the overview. The two glass-style controls use the system toolbar; the rows ask the shared ViewModel to open their
/// target and the app shows it.
struct AreaScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: AreaViewModel

    // MARK: - State
    @State private var showsSettings = false

    // MARK: - Init
    /// `viewModel` runs once per screen, when SwiftUI creates the state object.
    init(viewModel: @autoclosure @escaping () -> AreaViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .background(Theme.Colors.groupedBackground)
            .navigationTitle(Text(viewModel.state.name))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { showsSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel(Text("area.settings", bundle: .module))
                        .accessibilityIdentifier(AreasIdentifiers.settings)
                        .disabled(viewModel.state.phase != .content)
                }
            }
            .sheet(isPresented: $showsSettings) { settings }
            .alert(
                Text("area.failed", bundle: .module),
                isPresented: Binding(
                    get: { viewModel.state.writeFailure != nil },
                    set: { _ in viewModel.dismissFailure() }
                )
            ) {
                Button(role: .cancel) {} label: { Text("common.ok", bundle: .module) }
            } message: {
                Text(FailureKind.message(for: viewModel.state.writeFailure?.kind))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(AreasIdentifiers.screen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension AreaScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(message: Text(FailureKind.message(for: viewModel.state.failure)), retry: { viewModel.retry() })
            )
        case .content:
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.large) {
                    header
                    if !viewModel.state.active {
                        Label { Text("area.inactive", bundle: .module) } icon: { Image(systemName: "eye.slash") }
                            .padding(Theme.Spacing.medium)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
                            .accessibilityIdentifier(AreasIdentifiers.inactiveBanner)
                    }
                    note
                    stats
                    upcoming
                    related
                }
                .padding(Theme.Spacing.medium)
            }
            .refreshable { await viewModel.refresh() }
        }
    }

    var header: some View {
        HStack(spacing: Theme.Spacing.medium) {
            Image(systemName: AreaSymbols.area(icon: viewModel.state.icon))
                .font(.title)
                .foregroundStyle(.white)
                .frame(width: 52, height: 52)
                .background(tint, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityHidden(true)
            Text(viewModel.state.name).font(.largeTitle.weight(.bold)).accessibilityAddTraits(.isHeader)
        }
    }

    var note: some View {
        Button { viewModel.openNotes() } label: {
            HStack {
                Label { Text("area.note", bundle: .module) } icon: { Image(systemName: "note.text") }
                Spacer()
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(Theme.Spacing.medium)
            .frame(maxWidth: .infinity)
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(AreasIdentifiers.note)
    }

    var stats: some View {
        HStack(spacing: Theme.Spacing.small) {
            stat(viewModel.state.tasksToday, "area.stat.today", AreasIdentifiers.statToday, emphasized: true) {
                viewModel.openTasks(todayOnly: true)
            }
            stat(viewModel.state.tasksOpen, "area.stat.open", AreasIdentifiers.statOpen) {
                viewModel.openTasks(todayOnly: false)
            }
            stat(viewModel.state.eventsSoon, "area.stat.events", AreasIdentifiers.statEvents) {
                if let events = viewModel.state.related.first(where: { $0.databaseKey == "events" }) {
                    viewModel.open(events)
                }
            }
        }
    }

    func stat(
        _ value: Int,
        _ label: LocalizedStringKey,
        _ identifier: String,
        emphasized: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: String(value))
                    .font(.title2.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(emphasized && value > 0 ? Theme.Colors.destructive : .primary)
                Text(label, bundle: .module).font(.caption).foregroundStyle(Theme.Colors.secondaryText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.small + 4)
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }

    @ViewBuilder var upcoming: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            Text("area.section.upcoming", bundle: .module).font(.title3.weight(.bold))
            VStack(spacing: 0) {
                if viewModel.state.upcoming.isEmpty {
                    Text("area.upcoming.none", bundle: .module)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .padding(Theme.Spacing.medium)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(viewModel.state.upcoming) { item in
                    Button { viewModel.open(item) } label: { upcomingRow(item) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier(AreasIdentifiers.upcomingPrefix + item.id)
                    if item.id != viewModel.state.upcoming.last?.id {
                        Divider().padding(.leading, Theme.Spacing.large * 2)
                    }
                }
            }
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
        }
    }

    func upcomingRow(_ item: AreaUpcomingItem) -> some View {
        let dates = AreaDate(now: .now)
        let when = dates.when(date: item.date, timeFrom: item.timeFrom, timeTo: item.timeTo)
        return HStack(spacing: Theme.Spacing.medium) {
            Image(systemName: item.kind == .task ? "circle" : "calendar")
                .foregroundStyle(Color(hex: item.projectColor) ?? Theme.Colors.secondaryText)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title).lineLimit(1)
                Text([when, item.projectTitle].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(
                        dates.isLate(iso: item.date) ? Theme.Colors.destructive : Theme.Colors.secondaryText
                    )
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.vertical, Theme.Spacing.small + 2)
        .contentShape(Rectangle())
    }

    @ViewBuilder var related: some View {
        if !viewModel.state.related.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                Text("area.section.related", bundle: .module).font(.title3.weight(.bold))
                VStack(spacing: 0) {
                    ForEach(viewModel.state.related) { item in
                        Button { viewModel.open(item) } label: { relatedRow(item) }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier(AreasIdentifiers.relatedPrefix + item.databaseId)
                        if item.id != viewModel.state.related.last?.id {
                            Divider().padding(.leading, Theme.Spacing.large * 2)
                        }
                    }
                }
                .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: Theme.Radius.card))
            }
        }
    }

    func relatedRow(_ item: AreaRelatedItem) -> some View {
        HStack(spacing: Theme.Spacing.medium) {
            Image(systemName: AreaSymbols.collection(icon: item.icon, databaseKey: item.databaseKey))
                .font(.callout)
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(Color(hex: item.color) ?? Theme.Colors.accent, in: RoundedRectangle(cornerRadius: 8))
                .accessibilityHidden(true)
            Text(item.name)
            Spacer(minLength: Theme.Spacing.small)
            Text(verbatim: String(item.count)).foregroundStyle(Theme.Colors.secondaryText).monospacedDigit()
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, Theme.Spacing.medium)
        .padding(.vertical, Theme.Spacing.small + 2)
        .contentShape(Rectangle())
    }

    var settings: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle(
                        isOn: Binding(get: { viewModel.state.active }, set: { viewModel.setActive($0) })
                    ) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("area.active", bundle: .module)
                            Text(viewModel.state.active ? "area.active.hintOn" : "area.active.hintOff", bundle: .module)
                                .font(.footnote)
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                    }
                    .disabled(viewModel.state.activeSaving)
                    .accessibilityIdentifier(AreasIdentifiers.activeSwitch)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(
                Text(String(format: String(localized: "area.settings.title", bundle: .module), viewModel.state.name))
            )
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { showsSettings = false } label: { Text("area.done", bundle: .module) }
                }
            }
            .accessibilityIdentifier(AreasIdentifiers.settingsSheet)
        }
        .presentationDetents([.medium])
    }

    var tint: Color {
        Color(hex: viewModel.state.color) ?? Theme.Colors.accent
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        AreaScreen(
            viewModel: AreaViewModel(
                areaId: "a1",
                model: ScriptedAreaScreenModel(
                    state: AreaState(
                        phase: .content,
                        name: "Work",
                        color: "#5856D6",
                        icon: "briefcase",
                        tasksToday: 2,
                        tasksOpen: 7,
                        eventsSoon: 4,
                        upcoming: [
                            AreaUpcomingItem(
                                kind: .task,
                                id: "t1",
                                title: "Send the invoice",
                                date: "2026-10-21",
                                timeFrom: "14:00",
                                timeTo: "15:30",
                                projectTitle: "Accounting",
                                projectColor: "#8E8E93"
                            )
                        ],
                        related: [
                            AreaRelatedItem(
                                databaseId: "d1",
                                databaseKey: "projects",
                                name: "Projects",
                                icon: "folder",
                                color: "#AF52DE",
                                count: 7
                            )
                        ]
                    )
                ),
                router: PreviewAreasRouter()
            )
        )
    }
}
