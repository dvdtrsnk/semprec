import CoreKit
import Foundation

// MARK: - Preview data
extension NewItemState {

    static var preview: NewItemState {
        NewItemState(
            phase: .editing,
            calendars: [
                NewItemCalendar(id: "personal", name: "Osobní", color: "#5856D6", isDefault: true),
                NewItemCalendar(id: "work", name: "Práce", color: "#007AFF"),
                NewItemCalendar(id: "family", name: "Rodina", color: "#34C759"),
                NewItemCalendar(id: "health", name: "Zdraví", color: "#FF2D55")
            ],
            defaultDay: "2026-10-16"
        )
    }
}
