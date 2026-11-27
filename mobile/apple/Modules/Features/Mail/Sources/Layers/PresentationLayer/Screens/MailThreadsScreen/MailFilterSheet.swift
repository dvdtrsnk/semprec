import CoreKit
import DesignSystem
import SwiftUI

/// The sheet that narrows the thread list to a project. The counts are the number of threads each choice
/// leaves; they come from the server together with the names.
struct MailFilterSheet: View {

    // MARK: - Dependencies
    let state: MailThreadsState
    let send: (MailThreadsAction) -> Void

    // MARK: - State
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Body
    var body: some View {
        NavigationStack {
            content
                .navigationTitle(Text("mail.filter.title", bundle: .module))
                .inlineNavigationTitle()
                .toolbar {
                    PlainToolbarItem(placement: .cancellationAction) {
                        Button { send(.clearContext) } label: { Text("mail.filter.clear", bundle: .module) }
                            .disabled(state.projectId == nil)
                            .accessibilityIdentifier(MailIdentifiers.filterClear)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { dismiss() } label: { Text("mail.filter.done", bundle: .module) }
                            .accessibilityIdentifier(MailIdentifiers.filterDone)
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .accessibilityIdentifier(MailIdentifiers.filterSheet)
    }
}

// MARK: - Subviews
private extension MailFilterSheet {

    @ViewBuilder var content: some View {
        if hasOptions || state.facets.phase == .ready {
            groups
        } else if state.facets.phase == .error {
            StatusView(.failure(message: Text(FailureKind.message(for: nil)), retry: { send(.refresh) }))
        } else {
            StatusView(.loading)
        }
    }

    var hasOptions: Bool {
        !state.facets.projects.isEmpty
    }

    var groups: some View {
        List {
            Section {
                row(
                    key: "mail.filter.everything",
                    color: nil,
                    count: state.facets.projectTotal,
                    selected: state.projectId == nil
                ) { send(.setProject(nil)) }
                ForEach(state.facets.projects) { project in
                    row(
                        verbatim: project.name,
                        color: project.color,
                        count: project.count,
                        selected: state.projectId == project.id
                    ) { send(.setProject(project.id)) }
                }
            } header: {
                Text("mail.filter.project", bundle: .module)
            } footer: {
                Text("mail.filter.footer", bundle: .module)
            }
        }
        .groupedListStyle()
    }

    func row(
        verbatim title: String,
        color: String?,
        count: Int,
        selected: Bool,
        pick: @escaping () -> Void
    ) -> some View {
        Button(action: pick) { label(Text(verbatim: title), color: color, count: count, selected: selected) }
            .listRowButton()
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    func row(
        key title: LocalizedStringKey,
        color: String?,
        count: Int,
        selected: Bool,
        pick: @escaping () -> Void
    ) -> some View {
        Button(action: pick) { label(Text(title, bundle: .module), color: color, count: count, selected: selected) }
            .listRowButton()
            .accessibilityAddTraits(selected ? .isSelected : [])
    }

    func label(_ title: Text, color: String?, count: Int, selected: Bool) -> some View {
        HStack(spacing: Theme.Spacing.small + 4) {
            Circle().fill(Color(hex: color) ?? Color.clear).frame(width: 10, height: 10)
            title.foregroundStyle(.primary)
            Spacer(minLength: 0)
            Text(verbatim: String(count)).font(.subheadline).foregroundStyle(Theme.Colors.secondaryText)
            Image(systemName: "checkmark")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Theme.Colors.accent)
                .opacity(selected ? 1 : 0)
        }
    }
}

// MARK: - Preview
#Preview {
    MailFilterSheet(state: PreviewMail.threads, send: { _ in })
}
