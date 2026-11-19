import CoreKit
import DesignSystem
import SwiftUI

/// The new item sheet: an event or a task with its title, day and time, and for an event its place and calendar.
/// What is typed stays here and is handed over when the person adds the item; the sheet sits in the app's navigation
/// stack and closes itself when it is cancelled or the item exists.
struct NewItemScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: NewItemViewModel
    @Environment(\.dismiss)
    private var dismiss
    @State private var form: NewItemForm

    // MARK: - Init
    /// `day` (`YYYY-MM-DD`) is the day the form starts on, the one the model was made for.
    init(day: String, viewModel: @autoclosure @escaping () -> NewItemViewModel) {
        _viewModel = StateObject(wrappedValue: viewModel())
        _form = State(initialValue: NewItemForm(day: day))
    }

    // MARK: - Body
    var body: some View {
        content
            .navigationTitle(Text("newItem.title", tableName: "Sheets", bundle: .module))
            .inlineNavigationTitle()
            .toolbar { toolbar }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemScreen)
            .onChange(of: form) { viewModel.edited() }
            .onChange(of: viewModel.createdItemId) { _, created in
                if created != nil { dismiss() }
            }
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension NewItemScreen {

    var state: NewItemState {
        viewModel.state
    }

    var saving: Bool {
        state.phase == .saving
    }

    @ViewBuilder var content: some View {
        if state.phase == .loading {
            StatusView(.loading)
        } else {
            NewItemFormView(form: $form, calendars: state.calendars, failure: failure)
                .disabled(saving)
        }
    }

    /// The message of a failed save, `nil` while nothing failed. A refused form explains what to fix.
    var failure: String? {
        guard case .failed(let kind) = state.phase else { return nil }
        guard kind == .rejected else { return FailureKind.sheetMessage(for: kind) }
        return String(localized: "newItem.rejected", table: "Sheets", bundle: .module)
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button { dismiss() } label: {
                Label {
                    Text("newItem.cancel", tableName: "Sheets", bundle: .module)
                } icon: {
                    Image(systemName: "xmark")
                }
            }
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemCancel)
        }
        ToolbarItem(placement: .principal) {
            Picker(selection: $form.kind) {
                Text("newItem.kind.event", tableName: "Sheets", bundle: .module).tag(NewItemKind.event)
                Text("newItem.kind.task", tableName: "Sheets", bundle: .module).tag(NewItemKind.task)
            } label: {
                Text("newItem.kind", tableName: "Sheets", bundle: .module)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            // As wide as the system Calendar draws its Event and Reminder switch between the two buttons.
            .frame(width: 230)
            .disabled(saving)
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemKind)
        }
        ToolbarItem(placement: .confirmationAction) {
            if saving {
                ProgressView()
            } else {
                Button { viewModel.create(form) } label: {
                    Label {
                        Text("newItem.add", tableName: "Sheets", bundle: .module)
                    } icon: {
                        Image(systemName: "checkmark")
                    }
                }
                .disabled(!form.canSubmit || state.phase == .loading)
                .accessibilityIdentifier(CalendarSheetIdentifiers.newItemAdd)
            }
        }
    }
}

// MARK: - Preview
#Preview("Event") {
    NavigationStack {
        NewItemScreen(
            day: "2026-10-16",
            viewModel: NewItemViewModel(model: ScriptedNewItemScreenModel(state: .preview))
        )
    }
}

#Preview("Refused") {
    NavigationStack {
        NewItemScreen(
            day: "2026-10-16",
            viewModel: NewItemViewModel(
                model: ScriptedNewItemScreenModel(
                    state: NewItemState(
                        phase: .failed(.rejected), calendars: NewItemState.preview.calendars, defaultDay: "2026-10-16"
                    )
                )
            )
        )
    }
}

#Preview("Loading") {
    NavigationStack {
        NewItemScreen(
            day: "2026-10-16",
            viewModel: NewItemViewModel(
                model: ScriptedNewItemScreenModel(state: NewItemState(phase: .loading, defaultDay: "2026-10-16"))
            )
        )
    }
}
