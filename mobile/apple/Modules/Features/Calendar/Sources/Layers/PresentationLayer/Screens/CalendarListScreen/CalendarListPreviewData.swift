import CoreKit
import Foundation

// MARK: - Preview data
extension CalendarListState {

    /// The colours the shared layer offers, in its order.
    static let previewSwatches: [CalendarSwatch] = [
        CalendarSwatch(key: "red", hex: "#FF3B30"),
        CalendarSwatch(key: "orange", hex: "#FF9500"),
        CalendarSwatch(key: "yellow", hex: "#FFCC00"),
        CalendarSwatch(key: "green", hex: "#34C759"),
        CalendarSwatch(key: "teal", hex: "#30B0C7"),
        CalendarSwatch(key: "blue", hex: "#007AFF"),
        CalendarSwatch(key: "indigo", hex: "#5856D6"),
        CalendarSwatch(key: "purple", hex: "#AF52DE"),
        CalendarSwatch(key: "pink", hex: "#FF2D55"),
        CalendarSwatch(key: "brown", hex: "#A2845E"),
        CalendarSwatch(key: "gray", hex: "#8E8E93")
    ]

    static let previewCalendars: [CalendarRow] = [
        CalendarRow(id: "personal", name: "Osobní", color: "#5856D6", isDefault: true, canDelete: false),
        CalendarRow(id: "work", name: "Práce", color: "#007AFF"),
        CalendarRow(id: "family", name: "Rodina", color: "#34C759", hidden: true),
        CalendarRow(id: "health", name: "Zdraví", color: "#FF2D55"),
        system(id: "tasks", name: "Úkoly", color: "#007AFF"),
        system(id: "birthdays", name: "Narozeniny", color: "#8E8E93"),
        system(id: "sleep", name: "Spánek", color: "#5856D6"),
        CalendarRow(
            id: "holidays", name: "Státní svátky", color: "#34C759", notify: false, group: .subscription,
            systemKey: "holidaysCz", canRename: false, canDelete: false
        )
    ]

    static var previewList: CalendarListState {
        CalendarListState(phase: .content, calendars: previewCalendars, swatches: previewSwatches)
    }

    /// The own calendars and those of a Google account, one renamed and recoloured here, one read-only.
    static var previewAccounts: CalendarListState {
        let accountCalendars = [
            CalendarRow(
                id: "family", name: "Family", color: "#16A765", group: .account, canDelete: false, accountId: "m1",
                remoteName: "Family", remoteColor: "#16A765", usesRemoteColor: true
            ),
            CalendarRow(
                id: "team", name: "Tým", color: "#FF9500", group: .account, canDelete: false, accountId: "m1",
                remoteName: "Team", remoteColor: "#4986E7"
            ),
            CalendarRow(
                id: "czech", name: "Svátky v Česku", color: "#16A765", group: .account, canDelete: false,
                accountId: "m1", readOnly: true, remoteName: "Svátky v Česku", remoteColor: "#16A765",
                usesRemoteColor: true
            )
        ]
        return CalendarListState(
            phase: .content,
            calendars: Array(previewCalendars.prefix(2)) + accountCalendars,
            accounts: [
                CalendarAccountSection(
                    id: "m1", name: "Gmail", provider: "gmail", status: .ok, address: "david@gmail.com"
                )
            ],
            swatches: previewSwatches
        )
    }

    static var previewDetail: CalendarListState {
        CalendarListState(phase: .content, calendars: previewCalendars, swatches: previewSwatches, detailId: "work")
    }

    static var previewDelete: CalendarListState {
        CalendarListState(
            phase: .content,
            calendars: previewCalendars,
            swatches: previewSwatches,
            detailId: "work",
            impact: CalendarImpact(calendarId: "work", eventCount: 12, recipientCount: 4, cancellationCount: 6)
        )
    }

    private static func system(id: String, name: String, color: String) -> CalendarRow {
        CalendarRow(
            id: id, name: name, color: color, group: .system, systemKey: id, canRename: false, canDelete: false
        )
    }
}
