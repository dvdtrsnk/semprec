import CoreKit
import DesignSystem
import SwiftUI

/// Chooses the calendar of a new event as the system Calendar does: a list with a section per source under the
/// source's name, each calendar with its colour and a check on the chosen one. Choosing a calendar closes it.
struct NewItemCalendarChooser: View {

    // MARK: - Dependencies
    let choices: NewItemCalendarChoices
    let onChoose: (String) -> Void
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Body
    var body: some View {
        NavigationStack {
            List {
                ForEach(choices.sections) { section in
                    Section {
                        ForEach(section.rows) { row($0) }
                    } header: {
                        Text(section.title)
                            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemCalendarSection(section.id))
                    }
                }
            }
            .groupedListStyle()
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(CalendarSheetIdentifiers.newItemCalendarChooser)
            .navigationTitle(Text("newItem.calendar", tableName: "Sheets", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: { Text("calendars.done", tableName: "Sheets", bundle: .module) }
                        .accessibilityIdentifier(CalendarSheetIdentifiers.newItemCalendarDone)
                }
            }
        }
    }
}

// MARK: - Subviews
private extension NewItemCalendarChooser {

    func row(_ row: NewItemCalendarChoices.Row) -> some View {
        Button {
            onChoose(row.id)
            dismiss()
        } label: {
            HStack(spacing: 12) {
                Circle()
                    .fill(Color(hex: row.color) ?? Theme.Colors.accent)
                    .frame(width: 12, height: 12)
                Text(row.name)
                    .foregroundStyle(Color.primary)
                Spacer(minLength: Theme.Spacing.small)
                if row.isChosen {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.Colors.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .listRowButton()
        .accessibilityLabel(Text(row.label))
        .accessibilityAddTraits(row.isChosen ? .isSelected : [])
        .accessibilityIdentifier(CalendarSheetIdentifiers.newItemCalendarOption(row.id))
    }
}

// MARK: - Preview
#Preview {
    NewItemCalendarChooser(
        choices: NewItemCalendarChoices(groups: NewItemState.preview.groups, chosenId: "personal"),
        onChoose: { _ in }
    )
}
