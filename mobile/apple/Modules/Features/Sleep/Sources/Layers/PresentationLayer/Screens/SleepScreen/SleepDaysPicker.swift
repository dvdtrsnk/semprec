import DesignSystem
import SwiftUI

/// The seven days of the week as round buttons: a filled one is in the schedule, a dot under one marks a day another
/// schedule holds, which picking takes over.
struct SleepDaysPicker: View {

    // MARK: - Dependencies
    @Binding var days: Set<Int>
    let otherDays: Set<Int>

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
        .sensoryFeedback(.selection, trigger: days)
    }
}

// MARK: - Subviews
private extension SleepDaysPicker {

    func dayButton(_ day: Int) -> some View {
        let selected = days.contains(day)
        return Button {
            if selected { days.remove(day) } else { days.insert(day) }
        } label: {
            VStack(spacing: 6) {
                Text(verbatim: SleepFormat.weekdayInitial(day))
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(selected ? Color.white : Color.primary)
                    .frame(width: 42, height: 42)
                    .background(selected ? Theme.Colors.appAccent : Color.clear, in: Circle())
                Circle()
                    .fill(Color.secondary)
                    .frame(width: 6, height: 6)
                    .opacity(showsDot(day, selected: selected) ? 1 : 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: SleepFormat.weekdayLong(day)))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(SleepIdentifiers.dayPrefix + String(day))
    }

    /// A day out of this schedule that another schedule holds.
    func showsDot(_ day: Int, selected: Bool) -> Bool {
        !selected && otherDays.contains(day)
    }
}
