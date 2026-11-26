import CoreKit
import DesignSystem
import SwiftUI

/// The seven days of the week as round buttons: a filled one is in the schedule, a dot under one marks a day another
/// schedule holds, which picking takes over. Which days those are comes from the shared draft.
struct SleepDaysPicker: View {

    // MARK: - Dependencies
    let draft: SleepDraft
    let send: (SleepAction) -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: 0) {
            ForEach(1...7, id: \.self) { day in
                dayButton(day).frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, Theme.Spacing.medium)
        .padding(.horizontal, Theme.Spacing.small)
        .background(Theme.Colors.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .sensoryFeedback(.selection, trigger: draft.wakeDays)
    }
}

// MARK: - Subviews
private extension SleepDaysPicker {

    func dayButton(_ day: Int) -> some View {
        let selected = draft.role(of: day) == .selected
        let taken = draft.role(of: day) == .heldByAnotherPlan
        return Button { send(.draft(.toggleDay(day))) } label: {
            VStack(spacing: 6) {
                Text(verbatim: SleepFormat.weekdayInitial(day))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(selected ? Color.white : Color.primary)
                    .frame(width: 42, height: 42)
                    .background(selected ? Theme.Colors.appAccent : Color.clear, in: Circle())
                Circle()
                    .fill(Color.secondary)
                    .frame(width: 6, height: 6)
                    .opacity(taken ? 1 : 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: label(day, taken: taken)))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(SleepIdentifiers.dayPrefix + String(day))
    }

    /// The day's name, and for a day another schedule holds that taking it moves over.
    func label(_ day: Int, taken: Bool) -> String {
        guard taken else { return SleepFormat.weekdayLong(day) }
        return String(
            format: String(localized: "sleep.editor.day.otherPlan", bundle: .module),
            locale: .current,
            SleepFormat.weekdayLong(day)
        )
    }
}

// MARK: - Preview
#Preview("Days") {
    SleepDaysPicker(draft: .previewWeekend, send: { _ in })
        .padding()
        .background(Theme.Colors.groupedBackground)
}

// MARK: - Day role
/// How a weekday stands in a schedule being edited.
enum SleepDayRole: Equatable {

    /// The schedule holds the day.
    case selected
    /// Another schedule holds the day, which picking takes over.
    case heldByAnotherPlan
    case free
}

// MARK: - Day role
extension SleepDraft {

    func role(of day: Int) -> SleepDayRole {
        if wakeDays.contains(day) { return .selected }
        return takenDays.contains(day) ? .heldByAnotherPlan : .free
    }
}
