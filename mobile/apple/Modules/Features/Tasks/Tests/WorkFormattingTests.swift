import CoreKit
import XCTest

@testable import TasksFeature

final class WorkFormattingTests: XCTestCase {

    // MARK: - Properties
    private let calendar = Calendar(identifier: .gregorian)
    private let czech = Locale(identifier: "cs_CZ")
    private let american = Locale(identifier: "en_US")
    private let today = "2026-10-16"

    // MARK: - Days
    func testRelativeWordsNameYesterdayTodayAndTomorrowOnly() {
        XCTAssertEqual(WorkFormatting.relativeWord("2026-10-15", today: today, calendar: calendar), "Yesterday")
        XCTAssertEqual(WorkFormatting.relativeWord("2026-10-16", today: today, calendar: calendar), "Today")
        XCTAssertEqual(WorkFormatting.relativeWord("2026-10-17", today: today, calendar: calendar), "Tomorrow")
        XCTAssertNil(WorkFormatting.relativeWord("2026-10-18", today: today, calendar: calendar))
        XCTAssertNil(WorkFormatting.relativeWord("later", today: today, calendar: calendar))
        XCTAssertNil(WorkFormatting.relativeWord("2026-10-17", today: "never", calendar: calendar))
    }

    func testOtherDaysAreTheWeekdayAndTheDayInTheOrderOfTheLocale() {
        XCTAssertEqual(plain(day("2026-10-22", czech)), "čt 22. 10.")
        XCTAssertEqual(plain(day("2026-10-22", american)), "Thu, 10/22")
        XCTAssertEqual(day("2026-10-16", czech), "Today")
        XCTAssertEqual(plain(WorkFormatting.compactDay("2026-10-13", calendar: calendar, locale: czech)), "út 13. 10.")
        XCTAssertEqual(WorkFormatting.compactDay("nonsense", calendar: calendar, locale: czech), "nonsense")
    }

    func testTheLongDayLabelKeepsTheRelativeWordBeforeTheWeekday() {
        XCTAssertEqual(plain(longDay("2026-10-16")), "Today, pátek 16. 10.")
        XCTAssertEqual(plain(longDay("2026-10-22")), "Čtvrtek 22. 10.")
        XCTAssertEqual(longDay("nonsense"), "nonsense")
    }

    // MARK: - Times
    func testTimesAreWrittenAsTheBoardsDo() {
        XCTAssertEqual(WorkFormatting.timeRange(from: "14:00", to: "15:30"), "14:00–15:30")
        XCTAssertEqual(WorkFormatting.timeRange(from: "07:00", to: "07:15"), "7:00–7:15")
        XCTAssertEqual(WorkFormatting.timeRange(from: "09:05", to: nil), "9:05")
        XCTAssertNil(WorkFormatting.timeRange(from: nil, to: "10:00"))
        XCTAssertEqual(WorkFormatting.clock("10:00"), "10:00")
    }

    func testALengthIsWrittenInHoursAndMinutes() {
        XCTAssertEqual(WorkFormatting.length(minutes: 90, locale: american), "1h 30m")
        XCTAssertEqual(WorkFormatting.length(minutes: 45, locale: american), "45m")
        XCTAssertTrue(WorkFormatting.length(minutes: 90, locale: czech).contains("h"))
    }

    // MARK: - Rows
    func testALineNamesTheTimeTheProjectAndTheRepeat() {
        let row = TaskRow(
            id: "t", title: "A", date: "2026-10-22", timeFrom: "10:00", timeTo: "12:00",
            projectTitle: "Půlmaraton", repeats: .daily
        )
        XCTAssertEqual(plain(meta(row, .week)), "čt 22. 10. 10:00–12:00 · Půlmaraton · ↻ every day")
    }

    func testTheGroupAlreadySaysTodayOrTomorrow() {
        let row = TaskRow(
            id: "t", title: "A", date: today, timeFrom: "14:00", timeTo: "15:30", projectTitle: "Účetnictví"
        )
        XCTAssertEqual(meta(row, .today), "14:00–15:30 · Účetnictví")
        let tomorrow = TaskRow(id: "t", title: "A", date: "2026-10-17", timeFrom: "10:00")
        XCTAssertEqual(meta(tomorrow, .tomorrow), "10:00")
        XCTAssertEqual(meta(tomorrow, .week), "Tomorrow 10:00")
    }

    func testATaskMovedForwardSaysFromWhenInsteadOfItsTime() {
        let fromYesterday = TaskRow(id: "t", title: "A", date: today, movedFrom: "2026-10-15", projectTitle: "Zdraví")
        XCTAssertEqual(meta(fromYesterday, .today), "moved from yesterday · Zdraví")
        let older = TaskRow(id: "t", title: "A", date: today, movedFrom: "2026-10-13")
        XCTAssertEqual(plain(meta(older, .today)), "moved from út 13. 10.")
    }

    func testATaskWithoutADayOrAProjectHasNoLine() {
        XCTAssertEqual(meta(TaskRow(id: "t", title: "A"), .noDate), "")
    }

    func testEveryRepeatHasItsOwnTitle() {
        let titles = TaskRepeat.allCases.map(WorkFormatting.repeatTitle)
        XCTAssertEqual(Set(titles).count, TaskRepeat.allCases.count)
        XCTAssertFalse(titles.contains { $0.hasPrefix("repeat.") })
    }
}

// MARK: - Helpers
private extension WorkFormattingTests {

    /// The date formats of some locales separate their parts with no-break spaces; the tests compare plain spaces.
    func plain(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{202F}", with: " ")
    }

    func day(_ day: String, _ locale: Locale) -> String {
        WorkFormatting.dayLabel(day, today: today, calendar: calendar, locale: locale)
    }

    func longDay(_ day: String) -> String {
        WorkFormatting.longDayLabel(day, today: today, calendar: calendar, locale: czech)
    }

    func meta(_ row: TaskRow, _ group: TaskSectionKind) -> String {
        WorkFormatting.meta(for: row, in: group, today: today, calendar: calendar, locale: czech)
    }
}
