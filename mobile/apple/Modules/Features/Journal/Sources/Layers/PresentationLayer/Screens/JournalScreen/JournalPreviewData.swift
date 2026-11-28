import CoreKit

// A day of the diary as the previews show it; the screens never read these values.

// MARK: - Selection
extension JournalSelection {

    static let previewDay = JournalSelection(kind: .day, start: "2026-10-16")
}

// MARK: - Axis
extension Array where Element == JournalAxisRow {

    static let previewAxis: [JournalAxisRow] = [
        JournalAxisRow(kind: .year, cells: [
            axisCell(.year, "2025-01-01", year: 2025, onPath: false),
            axisCell(.year, "2026-01-01", year: 2026, onPath: true),
            axisCell(.year, "2027-01-01", year: 2027, onPath: false)
        ]),
        JournalAxisRow(kind: .month, cells: [
            axisCell(.month, "2026-09-01", quarter: 3, month: 9, onPath: false),
            axisCell(.month, "2026-10-01", quarter: 4, month: 10, onPath: true),
            axisCell(.month, "2026-11-01", quarter: 4, month: 11, onPath: false)
        ]),
        JournalAxisRow(kind: .day, cells: (14...18).map { day in
            axisCell(
                .day, "2026-10-\(day)", quarter: 4, month: 10, day: day, weekday: day - 11,
                onPath: day == 16, current: day == 16, today: day == 16
            )
        })
    ]

    private static func axisCell(
        _ kind: JournalPeriodKind,
        _ start: String,
        year: Int = 2026,
        quarter: Int = 1,
        month: Int = 1,
        day: Int = 1,
        weekday: Int = 1,
        onPath: Bool,
        current: Bool = false,
        today: Bool = false
    ) -> JournalAxisCell {
        JournalAxisCell(
            kind: kind, start: start, year: year, quarter: quarter, month: month, day: day, weekday: weekday,
            onPath: onPath, current: current, today: today
        )
    }
}

// MARK: - State
extension JournalState {

    static let previewDay = JournalState(
        phase: .content,
        selection: .previewDay,
        today: "2026-10-16",
        axis: .previewAxis,
        page: JournalPage(
            ref: JournalPageRef(kind: .day, period: "2026-10-16"),
            blocks: [
                JournalBlock(
                    index: 0, kind: .text,
                    runs: [
                        JournalRun(text: "Schůzka s Petrem dopadla dobře, "),
                        JournalRun(text: "rozpočet schválený", bold: true)
                    ]
                ),
                JournalBlock(index: 1, kind: .todo, runs: [JournalRun(text: "Dotáhnout mockup")]),
                JournalBlock(index: 2, kind: .page, runs: [JournalRun(text: "Krkonoše – co sbalit")], pageId: "jv1")
            ]
        ),
        weeks: [
            JournalWeek(
                number: 42, firstDay: "2026-10-12", lastDay: "2026-10-18",
                page: JournalPage(ref: JournalPageRef(kind: .week, period: "2026-W42"), blocks: [])
            )
        ],
        events: [
            JournalEvent(
                id: "e1", title: "Standup", startMinutes: 540, endMinutes: 570,
                projectName: "Alldots iOS", projectColor: "#007AFF"
            ),
            JournalEvent(
                id: "e2", title: "Schůzka s klientem", startMinutes: 600, endMinutes: 690, place: "Kancelář, Karlín",
                projectColor: "#AF52DE", hasTranscript: true
            )
        ],
        birthdays: [JournalBirthday(id: "b1", personName: "Jana Kovářová")],
        inbox: [
            JournalInboxItem(id: "i1", time: "08:15", text: "Nápad: šablona nabídky pro klienty", emoji: "💡"),
            JournalInboxItem(
                id: "i2", time: "18:02", text: "Faktura za obklady", emoji: "💸", status: .proposed,
                attachmentName: "Fotka 18:02", attachmentCount: 1
            )
        ]
    )
}
