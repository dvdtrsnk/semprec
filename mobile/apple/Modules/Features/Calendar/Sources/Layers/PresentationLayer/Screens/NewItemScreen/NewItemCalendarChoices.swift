import CoreKit
import Foundation

/// What the calendar chooser of the new item sheet lists: a section per source, the own calendars first, headed by
/// the source's title, each calendar with its colour, its name, a label that names its source when another calendar
/// has the same name, and whether it is the chosen one.
struct NewItemCalendarChoices {

    // MARK: - Types
    struct Section: Identifiable {
        /// `own` for the own calendars, `account.<id>` for an internet account's.
        let id: String
        let title: String
        let rows: [Row]
    }

    struct Row: Identifiable {
        /// The calendar's id.
        let id: String
        let name: String
        /// The calendar's colour, `#RRGGBB`.
        let color: String
        /// The name followed by the source when the name alone is ambiguous (`Osobní · iCloud`).
        let label: String
        let isChosen: Bool
    }

    // MARK: - Properties
    let sections: [Section]

    // MARK: - Init
    init(groups: [NewItemCalendarGroup], chosenId: String) {
        sections = groups.map { group in
            Section(
                id: group.account.map { "account.\($0.id)" } ?? "own",
                title: NewItemOptions.title(of: group),
                rows: group.calendars.map { calendar in
                    Row(
                        id: calendar.id,
                        name: calendar.name,
                        color: calendar.color,
                        label: NewItemOptions.label(of: calendar),
                        isChosen: calendar.id == chosenId
                    )
                }
            )
        }
    }
}
