import CoreKit
import DesignSystem
import SwiftUI

/// One calendar of the calendars sheet: a tap on the row shows or hides it, the info button opens its settings (the
/// sleep plan for the sleep calendar). A read-only calendar carries a lock.
struct CalendarListRow: View {

    // MARK: - Dependencies
    let calendar: CalendarRow
    let send: (CalendarListAction) -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            Button { send(.change(.toggleHidden(calendarId: calendar.id))) } label: { label }
                .listRowButton()
                .buttonStyle(.plain)
                .accessibilityLabel(Text(toggleLabel))
                .accessibilityAddTraits(calendar.hidden ? [] : .isSelected)
                .accessibilityIdentifier(CalendarSheetIdentifiers.calendarToggle(calendar.id))
            Button { send(calendar.isSleep ? .openSleep : .openDetail(calendarId: calendar.id)) } label: {
                Image(systemName: "info.circle")
                    .font(.title3)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text(infoLabel))
            .accessibilityIdentifier(CalendarSheetIdentifiers.calendarInfo(calendar.id))
        }
    }
}

// MARK: - Subviews
private extension CalendarListRow {

    var tint: Color {
        Color(hex: calendar.color) ?? Theme.Colors.accent
    }

    var label: some View {
        HStack(spacing: Theme.Spacing.medium) {
            checkbox
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Spacing.small) {
                    Text(calendar.name)
                        .foregroundStyle(calendar.hidden ? Theme.Colors.secondaryText : Color.primary)
                    if calendar.readOnly {
                        Image(systemName: "lock.fill")
                            .font(.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                            .accessibilityLabel(Text("calendars.readOnly", tableName: "Sheets", bundle: .module))
                            .accessibilityIdentifier(CalendarSheetIdentifiers.calendarReadOnly(calendar.id))
                    }
                }
                if let subtitle = calendar.subtitle {
                    Text(subtitle)
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder var checkbox: some View {
        if calendar.hidden {
            Circle()
                .strokeBorder(tint, lineWidth: 2)
                .frame(width: Self.checkboxSize, height: Self.checkboxSize)
        } else {
            Image(systemName: "checkmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: Self.checkboxSize, height: Self.checkboxSize)
                .background(tint, in: .circle)
        }
    }

    static let checkboxSize: CGFloat = 22

    var toggleLabel: String {
        let format = calendar.hidden ?
            String(localized: "calendars.toggle.show", table: "Sheets", bundle: .module)
            : String(localized: "calendars.toggle.hide", table: "Sheets", bundle: .module)
        return String(format: format, locale: .current, calendar.name)
    }

    var infoLabel: String {
        guard !calendar.isSleep else {
            return String(localized: "calendars.info.sleep", table: "Sheets", bundle: .module)
        }
        return String(
            format: String(localized: "calendars.info.edit", table: "Sheets", bundle: .module),
            locale: .current,
            calendar.name
        )
    }
}

// MARK: - Preview
#Preview("Rows") {
    List {
        CalendarListRow(calendar: CalendarRow(id: "work", name: "Práce", color: "#007AFF"), send: { _ in })
        CalendarListRow(
            calendar: CalendarRow(id: "sleep", name: "Spánek", color: "#5856D6", hidden: true, systemKey: "sleep"),
            send: { _ in }
        )
        CalendarListRow(
            calendar: CalendarRow(id: "shared", name: "Svátky", color: "#16A765", group: .account, readOnly: true),
            send: { _ in }
        )
    }
}
