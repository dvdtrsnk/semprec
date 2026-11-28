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
            Form {
                Section {
                    Picker(selection: selection) {
                        Text("details.noProject", bundle: .module).tag(String?.none)
                        ForEach(state.projectChoices) { project in
                            Label {
                                Text(project.title)
                            } icon: {
                                Image(systemName: "square.fill")
                                    .foregroundStyle(Color(hex: project.color) ?? Color.secondary.opacity(0.4))
                            }
                            .tag(String?.some(project.id))
                        }
                    } label: {
                        Text("details.project", bundle: .module)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
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

    /// Picking a project writes it and returns to the sheet.
    var selection: Binding<String?> {
        Binding(
            get: { state.project?.id },
            set: { id in
                send(.selectProject(id))
                pick()
            }
        )
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
        Form {
            Section {
                Picker(selection: selection) {
                    ForEach(options, id: \.self) { option in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(WorkFormatting.repeatTitle(option))
                            if option == .never {
                                Text("details.repeat.neverHint", bundle: .module)
                                    .font(.footnote)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                        }
                        .tag(option)
                    }
                } label: {
                    Text("details.repeat", bundle: .module)
                }
                .pickerStyle(.inline)
                .labelsHidden()
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

    /// Picking a repeat writes it and returns to the sheet.
    var selection: Binding<TaskRepeat> {
        Binding(
            get: { state.repeats },
            set: { option in
                send(.setRepeat(option))
                pick()
            }
        )
    }

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
