import SharedSDK

/// Kotlin diary values for the mapping tests; the real ViewModels, which need a signed-in server, never reach most of
/// the branches these exercise. Both modules declare the same type names, so each Kotlin type is qualified.
enum JournalKotlin {

    // MARK: - Builders
    static func run(
        _ text: String,
        bold: Bool = false,
        link: String? = nil
    ) -> SharedSDK.JournalRun {
        SharedSDK.JournalRun(text: text, bold: bold, italic: false, code: false, link: link)
    }

    static func block(
        index: Int32,
        kind: SharedSDK.JournalBlockKind,
        runs: [SharedSDK.JournalRun] = [],
        pageId: String? = nil
    ) -> SharedSDK.JournalBlock {
        SharedSDK.JournalBlock(
            index: index, kind: kind, indent: 1, done: true, ordinal: 0, runs: runs, pageId: pageId
        )
    }

    static func state(
        _ phase: SharedSDK.JournalPhase,
        failure: SharedSDK.FailureKind? = nil,
        page: SharedSDK.JournalPageState? = nil,
        weeks: [SharedSDK.JournalWeekState] = [],
        events: [SharedSDK.JournalEventState] = [],
        birthdays: [SharedSDK.JournalBirthdayState] = [],
        inbox: [SharedSDK.JournalInboxState] = [],
        axis: [SharedSDK.JournalAxisRowState] = [],
        shown: SharedSDK.JournalSelection? = nil
    ) -> SharedSDK.JournalState {
        SharedSDK.JournalState(
            phase: phase,
            selection: SharedSDK.JournalSelection(kind: .month, start: "2026-10-01"),
            today: "2026-10-16",
            axis: axis,
            failure: failure,
            page: page,
            weeks: weeks,
            events: events,
            birthdays: birthdays,
            inbox: inbox,
            shown: shown
        )
    }

    static func event(
        start: Int32? = nil,
        end: Int32? = nil,
        allDay: Bool = false
    ) -> SharedSDK.JournalEventState {
        SharedSDK.JournalEventState(
            id: "e1", title: "Standup", startMinutes: start.map { KotlinInt(int: $0) },
            endMinutes: end.map { KotlinInt(int: $0) }, allDay: allDay, place: "Office",
            projectName: "Semprec", projectColor: "#007AFF", hasTranscript: true
        )
    }

    static func cell() -> SharedSDK.JournalAxisCellState {
        SharedSDK.JournalAxisCellState(
            kind: .day, start: "2026-10-16", year: 2026, quarter: 4, month: 10, day: 16, weekday: 5,
            onPath: true, current: true, today: false
        )
    }
}
