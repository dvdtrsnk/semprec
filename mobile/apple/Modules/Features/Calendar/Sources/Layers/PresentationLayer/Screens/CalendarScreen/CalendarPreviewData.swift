import CoreKit

/// A day of the calendar as the previews show it; the screens never read these values. The items are the ones the
/// design boards use: Friday 16 October 2026 with a meeting, a lunch, a focus block, tasks and the sleep of the night.
@MainActor
enum CalendarPreviewData {

    // MARK: - State
    static func state(
        zoom: CalendarZoom = .day,
        selected: String = "2026-10-16",
        drag: CalendarDrag? = nil,
        selectedItemId: String? = nil,
        clipboard: CalendarClipboard? = nil
    ) -> CalendarState {
        CalendarState(
            phase: .content,
            zoom: zoom,
            selectedDay: selected,
            today: "2026-10-16",
            nowMinutes: 13 * 60 + 24,
            days: days(),
            monthGrid: (0..<42).map { CalendarDates.shifted("2026-09-28", by: $0) },
            months: (1...12).map { month in
                CalendarMonthState(year: 2026, month: month, leading: leading[month - 1], length: lengths[month - 1])
            },
            pendingInvitations: 2,
            selectedItemId: selectedItemId,
            drag: drag,
            clipboard: clipboard
        )
    }

    // MARK: - Days
    static func days() -> [CalendarDayState] {
        let items: [String: [CalendarItem]] = [
            "2026-10-16": today,
            "2026-10-15": [
                event("zubar", "Zubař", color: "#FF3B30", date: "2026-10-15", minutes: 13 * 60...14 * 60)
            ],
            "2026-10-17": [
                event(
                    "vecere", "Večeře s rodinou", color: "#34C759", date: "2026-10-17",
                    minutes: 18 * 60...19 * 60 + 30
                )
            ]
        ]
        return (0..<57).map { offset in
            let date = CalendarDates.shifted("2026-09-21", by: offset)
            return CalendarDayState(
                date: date,
                items: items[date] ?? [],
                sleepEvening: date == "2026-10-16" ? sleep : nil,
                sleepMorning: date == "2026-10-17" ? sleep : nil
            )
        }
    }

    // MARK: - Items
    static let today: [CalendarItem] = [
        CalendarItem(
            id: "narozeniny", kind: .birthday, title: "Narozeniny – Jana", color: "#34C759", date: "2026-10-16",
            allDay: true, editable: false
        ),
        event("standup", "Standup", color: "#007AFF", date: "2026-10-16", minutes: 9 * 60...9 * 60 + 30),
        CalendarItem(
            id: "klient", kind: .event, title: "Schůzka s klientem", color: "#AF52DE", date: "2026-10-16",
            allDay: false, startMinutes: 10 * 60, endMinutes: 11 * 60 + 30, hasEnd: true, place: "Kancelář, Karlín",
            tasks: [
                CalendarEventTask(id: "t-rozpocet", title: "Potvrdit rozpočet", state: .open, note: nil),
                CalendarEventTask(id: "t-web", title: "Struktura webu", state: .done, note: nil)
            ]
        ),
        event("obed", "Oběd s Petrem", color: "#34C759", date: "2026-10-16", minutes: 12 * 60...13 * 60),
        CalendarItem(
            id: "faktura", kind: .task, title: "Odeslat fakturu", color: "#007AFF", date: "2026-10-16", allDay: false,
            startMinutes: 14 * 60, endMinutes: 15 * 60 + 30, hasEnd: true
        ),
        event("fokus", "Fokus: Semprec iOS", color: "#FF9500", date: "2026-10-16", minutes: 15 * 60...16 * 60 + 30),
        CalendarItem(
            id: "najem", kind: .task, title: "Zaplatit nájem", color: "#007AFF", date: "2026-10-16", allDay: true
        )
    ]

    static let sleep = CalendarSleep(
        night: "2026-10-16", bedMinutes: 23 * 60, wakeMinutes: 6 * 60 + 45, alarm: true, changed: false,
        prepMinutes: 22 * 60 + 30
    )

    // MARK: - Private
    private static let leading = [3, 6, 6, 2, 4, 0, 2, 5, 1, 3, 6, 1]
    private static let lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

    private static func event(
        _ id: String,
        _ title: String,
        color: String,
        date: String,
        minutes: ClosedRange<Int>
    ) -> CalendarItem {
        CalendarItem(
            id: id, kind: .event, title: title, color: color, date: date, allDay: false,
            startMinutes: minutes.lowerBound, endMinutes: minutes.upperBound, hasEnd: true
        )
    }
}
