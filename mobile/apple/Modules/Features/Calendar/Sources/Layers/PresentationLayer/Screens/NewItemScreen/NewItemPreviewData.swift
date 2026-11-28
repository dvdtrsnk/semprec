import CoreKit
import Foundation

// MARK: - Preview data
extension NewItemState {

    /// The own calendars and an iCloud account's, two of which share their names with own ones.
    static var preview: NewItemState {
        let icloud = NewItemAccount(id: "m1", name: "iCloud", address: "david@tresnak.cc")
        return NewItemState(
            phase: .editing,
            groups: [
                NewItemCalendarGroup(calendars: [
                    NewItemCalendar(
                        id: "personal", name: "Osobní", color: "#5856D6", isDefault: true, qualifier: .own
                    ),
                    NewItemCalendar(id: "work", name: "Práce", color: "#007AFF"),
                    NewItemCalendar(id: "family", name: "Rodina", color: "#34C759", qualifier: .own)
                ]),
                NewItemCalendarGroup(account: icloud, calendars: [
                    NewItemCalendar(
                        id: "icloud-personal", name: "Osobní", color: "#FF9500", account: icloud,
                        qualifier: .accountName
                    ),
                    NewItemCalendar(
                        id: "icloud-family", name: "Rodina", color: "#FF2D55", account: icloud,
                        qualifier: .accountName
                    ),
                    NewItemCalendar(id: "icloud-work", name: "Work", color: "#AF52DE", account: icloud)
                ])
            ],
            defaultDay: "2026-10-16"
        )
    }
}
