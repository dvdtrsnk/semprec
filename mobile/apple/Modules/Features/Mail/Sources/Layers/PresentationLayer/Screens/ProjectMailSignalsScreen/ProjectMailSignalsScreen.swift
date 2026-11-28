import CoreKit
import DesignSystem
import SwiftUI

/// The mail signals of a project: its people (read only), its own domains, addresses and keywords, and the open
/// threads they match, previewed while the lists change. Save keeps the lists; Assign gives the project to the
/// threads the saved signals match.
struct ProjectMailSignalsScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: ProjectMailSignalsViewModel

    // MARK: - Init
    init(viewModel: @autoclosure @escaping () -> ProjectMailSignalsViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("mail.signals.title", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { viewModel.send(.save) } label: { Text("mail.signals.save", bundle: .module) }
                        .disabled(!viewModel.state.canSave)
                        .accessibilityIdentifier(MailIdentifiers.signalsSave)
                }
            }
            .alert(
                Text(failureTitle, bundle: .module),
                isPresented: Binding(
                    get: { failure != nil },
                    set: { _ in viewModel.send(.dismissFailure) }
                )
            ) {
                Button(role: .cancel) {} label: { Text("state.ok", bundle: .module) }
            } message: {
                Text(FailureKind.message(for: failure?.kind))
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(MailIdentifiers.signalsScreen)
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension ProjectMailSignalsScreen {

    @ViewBuilder var content: some View {
        switch viewModel.state.phase {
        case .loading:
            StatusView(.loading)
        case .error:
            StatusView(
                .failure(message: Text(FailureKind.message(for: viewModel.state.failure)), retry: {
                    viewModel.send(.retry)
                })
            )
        case .ready:
            form
        }
    }

    var form: some View {
        Form {
            peopleSection
            listSection(.domains, title: "mail.signals.domains", footer: "mail.signals.domains.footer")
            listSection(.addresses, title: "mail.signals.addresses", footer: "mail.signals.addresses.footer")
            listSection(.keywords, title: "mail.signals.keywords", footer: "mail.signals.keywords.footer")
            ProjectMailSignalsPreviewSection(state: viewModel.state, send: viewModel.send)
        }
        .groupedListStyle()
    }

    var peopleSection: some View {
        Section {
            if viewModel.state.people.isEmpty {
                Text("mail.signals.people.empty", bundle: .module).foregroundStyle(Theme.Colors.secondaryText)
            }
            ForEach(viewModel.state.people) { person in
                VStack(alignment: .leading, spacing: 2) {
                    if !person.name.isEmpty { Text(verbatim: person.name) }
                    Text(verbatim: person.address).font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(MailIdentifiers.signalsPersonPrefix + person.address)
            }
        } header: {
            Text("mail.signals.people", bundle: .module)
        } footer: {
            Text("mail.signals.people.footer", bundle: .module)
        }
    }

    func listSection(_ field: MailSignalField, title: LocalizedStringKey, footer: LocalizedStringKey) -> some View {
        Section {
            ForEach(viewModel.state.values(field), id: \.self) { value in
                HStack {
                    Text(verbatim: value)
                    Spacer(minLength: 0)
                    Button { viewModel.send(.remove(field, value: value)) } label: {
                        Image(systemName: "minus.circle.fill").foregroundStyle(Theme.Colors.destructive)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(removeLabel(value))
                    .accessibilityIdentifier(MailIdentifiers.signalsRemovePrefix + field.identifier + "." + value)
                }
            }
            MailSignalInputRow(field: field, sharedText: viewModel.state.input(field), send: viewModel.send)
        } header: {
            Text(title, bundle: .module)
        } footer: {
            VStack(alignment: .leading, spacing: Theme.Spacing.small) {
                if viewModel.state.invalidField == field {
                    Text(invalidMessage(field), bundle: .module)
                        .foregroundStyle(Theme.Colors.destructive)
                        .accessibilityIdentifier(MailIdentifiers.signalsInvalidPrefix + field.identifier)
                }
                Text(footer, bundle: .module)
            }
        }
    }

    func removeLabel(_ value: String) -> Text {
        let format = String(localized: "mail.signals.remove", bundle: .module)
        return Text(verbatim: String(format: format, locale: .current, value))
    }

    func invalidMessage(_ field: MailSignalField) -> LocalizedStringKey {
        switch field {
        case .domains: "mail.signals.domains.invalid"
        case .addresses: "mail.signals.addresses.invalid"
        case .keywords: "mail.signals.keywords.invalid"
        }
    }

    /// A failed save or assignment; at most one of them is shown.
    var failure: Failed? { viewModel.state.saveFailure ?? viewModel.state.assignFailure }

    var failureTitle: LocalizedStringKey {
        viewModel.state.saveFailure != nil ? "mail.signals.saveFailed" : "mail.signals.assignFailed"
    }
}

// MARK: - Preview
#Preview {
    NavigationStack {
        ProjectMailSignalsScreen(
            viewModel: ProjectMailSignalsViewModel(
                model: ScriptedProjectMailSignalsScreenModel(state: PreviewMail.signals)
            )
        )
    }
}

#Preview("Unsaved, refused") {
    NavigationStack {
        ProjectMailSignalsScreen(
            viewModel: ProjectMailSignalsViewModel(
                model: ScriptedProjectMailSignalsScreenModel(state: PreviewMail.unsavedSignals)
            )
        )
    }
}
