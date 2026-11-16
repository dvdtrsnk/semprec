import CoreKit
import DesignSystem
import SwiftUI

/// The lists the Podrobnosti sheet pushes inside itself.
enum ItemDetailsPage: Hashable {

    case project
    case people
    case repeats
}

/// The projects to put the item in, or none.
struct ProjectPickerPage: View {

    // MARK: - Dependencies
    let state: ItemDetailsState
    let send: (ItemDetailsAction) -> Void
    let pick: () -> Void

    // MARK: - Body
    var body: some View {
        ChoicesContent(phase: state.choices, retry: { send(.loadChoices) }, content: {
            List {
                Section {
                    row(
                        title: String(localized: "details.noProject", bundle: .module),
                        subtitle: nil,
                        color: nil,
                        selected: state.project == nil,
                        action: { send(.selectProject(nil)) }
                    )
                    ForEach(state.projectChoices) { project in
                        row(
                            title: project.title,
                            subtitle: project.areaTitle,
                            color: project.color,
                            selected: state.project?.id == project.id,
                            action: { send(.selectProject(project.id)) }
                        )
                    }
                } footer: {
                    Text(footerKey, bundle: .module)
                }
            }
        })
        .navigationTitle(Text("details.project", bundle: .module))
        .inlineNavigationTitle()
        .task { send(.loadChoices) }
    }
}

// MARK: - Private
private extension ProjectPickerPage {

    var footerKey: LocalizedStringKey {
        state.projectLink?.state == .inherited ? "details.project.hintLinked" : "details.project.hint"
    }

    func row(
        title: String,
        subtitle: String?,
        color: String?,
        selected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            action()
            pick()
        } label: {
            HStack(spacing: Theme.Spacing.small) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color(hex: color) ?? Color.secondary.opacity(0.4))
                    .frame(width: 14, height: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(Color.primary)
                    if let subtitle { Text(subtitle).font(.footnote).foregroundStyle(Theme.Colors.secondaryText) }
                }
                Spacer()
                if selected { Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent) }
            }
        }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The people of a task, or the attendees of an event: tap to add or remove each.
struct PeoplePickerPage: View {

    // MARK: - Dependencies
    let state: ItemDetailsState
    let send: (ItemDetailsAction) -> Void

    // MARK: - Body
    var body: some View {
        ChoicesContent(phase: state.choices, retry: { send(.loadChoices) }, content: {
            List {
                Section {
                    ForEach(state.personChoices) { person in
                        let selected = state.people.contains { $0.id == person.id }
                        Button { send(.togglePerson(person.id)) } label: {
                            HStack(spacing: Theme.Spacing.small) {
                                Text(initials(person.title))
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.white)
                                    .frame(width: 30, height: 30)
                                    .background(Color(hex: person.color) ?? Theme.Colors.accent, in: Circle())
                                Text(person.title).foregroundStyle(Color.primary)
                                Spacer()
                                if selected { Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent) }
                            }
                        }
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                } footer: {
                    Text(state.kind == .event ? "details.people.hintEvent" : "details.people.hint", bundle: .module)
                }
            }
        })
        .navigationTitle(Text(state.kind == .event ? "details.attendees" : "details.people", bundle: .module))
        .inlineNavigationTitle()
        .task { send(.loadChoices) }
    }
}

// MARK: - Private
private extension PeoplePickerPage {

    func initials(_ name: String) -> String {
        name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

/// How often a task repeats.
struct RepeatPickerPage: View {

    // MARK: - Dependencies
    let state: ItemDetailsState
    let send: (ItemDetailsAction) -> Void
    let pick: () -> Void

    // MARK: - Body
    var body: some View {
        List {
            Section {
                ForEach(options, id: \.self) { option in
                    Button {
                        send(.setRepeat(option))
                        pick()
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(WorkFormatting.repeatTitle(option)).foregroundStyle(Color.primary)
                                if option == .never {
                                    Text("details.repeat.neverHint", bundle: .module)
                                        .font(.footnote)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                            }
                            Spacer()
                            if state.repeats == option {
                                Image(systemName: "checkmark").foregroundStyle(Theme.Colors.accent)
                            }
                        }
                    }
                    .accessibilityAddTraits(state.repeats == option ? .isSelected : [])
                }
            } footer: {
                Text("details.repeat.hint", bundle: .module)
            }
        }
        .navigationTitle(Text("details.repeat", bundle: .module))
        .inlineNavigationTitle()
    }
}

// MARK: - Private
private extension RepeatPickerPage {

    /// A repeat the app does not set (a custom rule) is shown while it is the current one, and is kept until another
    /// is picked.
    var options: [TaskRepeat] {
        [.never, .daily, .weekdays, .weekly, .monthly] + (state.repeats == .custom ? [.custom] : [])
    }
}

/// Waits for the choices of a picker, offers a retry when they could not be loaded, and shows `content` once there.
private struct ChoicesContent<Content: View>: View {

    // MARK: - Dependencies
    let phase: ChoicesPhase
    let retry: @MainActor () -> Void
    @ViewBuilder let content: () -> Content

    // MARK: - Body
    var body: some View {
        switch phase {
        case .idle, .loading:
            StatusView(.loading)
        case .failed:
            StatusView(.failure(message: Text(FailureKind.message(for: nil)), retry: retry))
        case .ready:
            content()
        }
    }
}
