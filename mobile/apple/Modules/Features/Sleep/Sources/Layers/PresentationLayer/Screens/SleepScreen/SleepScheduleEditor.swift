import CoreKit
import DesignSystem
import SwiftUI

/// The sheet that adds or changes one schedule: the days it is active, bedtime and wake-up on the dial, its length
/// against the goal, the alarm, and deleting it. It shows the shared draft and sends what the person does; nothing is
/// written until the person confirms, and closing it discards the draft.
struct SleepScheduleEditor: View {

    // MARK: - Dependencies
    let draft: SleepDraft
    /// Whether a write failed, with its typed reason; the failure is shown here while the editor is open.
    let saveFailed: Binding<Bool>
    let saveFailure: FailureKind?
    let send: (SleepAction) -> Void

    // MARK: - State
    @State private var confirmsDelete = false

    // MARK: - Body
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.medium) {
                    Text(draft.isNew ? "sleep.editor.addTitle" : "sleep.editor.editTitle", bundle: .module)
                        .font(.largeTitle.bold())
                        .padding(.bottom, Theme.Spacing.small)
                    header("sleep.editor.days")
                    SleepDaysPicker(draft: draft, send: send)
                    header("sleep.editor.times")
                    SleepTimesCard(draft: draft, send: send)
                    alarmCard
                    if draft.canDelete { deleteButton }
                }
                .padding(.horizontal, Theme.Spacing.medium)
                .padding(.bottom, Theme.Spacing.large)
            }
            .background(Theme.Colors.groupedBackground)
            .toolbar { toolbar }
            .confirmationDialog(
                Text("sleep.editor.delete.confirm", bundle: .module),
                isPresented: $confirmsDelete,
                titleVisibility: .visible
            ) {
                Button(role: .destructive) { actions.delete() } label: {
                    Text("sleep.editor.delete", bundle: .module)
                }
            }
        }
        .alert(
            Text("sleep.save.failed", bundle: .module),
            isPresented: saveFailed,
            actions: {
                Button { send(.dismissSaveFailure) } label: { Text("sleep.save.dismiss", bundle: .module) }
            },
            message: { Text(FailureKind.sleepMessage(for: saveFailure)) }
        )
        .accessibilityIdentifier(SleepIdentifiers.editor)
    }
}

// MARK: - Subviews
private extension SleepScheduleEditor {

    var actions: SleepEditorActions {
        SleepEditorActions(draft: draft, send: send)
    }

    func header(_ key: LocalizedStringKey) -> some View {
        Text(key, bundle: .module)
            .font(.headline)
            .foregroundStyle(Theme.Colors.secondaryText)
            .padding(.horizontal, Theme.Spacing.medium)
            .padding(.top, Theme.Spacing.small)
    }

    var alarmCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            header("sleep.editor.alarmOptions")
            Toggle(isOn: SleepBindings.isOn(draft.alarm) { actions.setAlarm($0) }) {
                Text("sleep.editor.alarmToggle", bundle: .module)
            }
            .padding(Theme.Spacing.medium)
            .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .accessibilityIdentifier(SleepIdentifiers.alarm)
        }
    }

    var deleteButton: some View {
        Button(role: .destructive) { confirmsDelete = true } label: {
            Text("sleep.editor.delete", bundle: .module)
                .frame(maxWidth: .infinity)
                .padding(Theme.Spacing.medium)
                .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.Colors.destructive)
        .padding(.top, Theme.Spacing.small)
        .accessibilityIdentifier(SleepIdentifiers.deletePlan)
    }

    @ToolbarContentBuilder var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button { actions.close() } label: {
                Label { Text("sleep.close", bundle: .module) } icon: { Image(systemName: "xmark") }
            }
            .accessibilityIdentifier(SleepIdentifiers.editorClose)
        }
        ToolbarItem(placement: .confirmationAction) {
            Button { actions.confirm() } label: {
                if draft.isNew {
                    Text("sleep.editor.add", bundle: .module)
                } else {
                    Label { Text("sleep.done", bundle: .module) } icon: { Image(systemName: "checkmark") }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!draft.canSave)
            .accessibilityIdentifier(SleepIdentifiers.editorConfirm)
        }
    }
}

// MARK: - Preview
#Preview("Edit") {
    SleepScheduleEditor(draft: .previewWeekdays, saveFailed: .constant(false), saveFailure: nil, send: { _ in })
}

#Preview("Add") {
    SleepScheduleEditor(draft: .previewNew, saveFailed: .constant(false), saveFailure: nil, send: { _ in })
}

#Preview("Failed") {
    SleepScheduleEditor(draft: .previewWeekdays, saveFailed: .constant(true), saveFailure: .rejected, send: { _ in })
}
