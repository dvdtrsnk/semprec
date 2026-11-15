import XCTest

@testable import DesignSystem

/// The day, month and time arithmetic behind the date and time pickers.
final class DatePickerValueTests: XCTestCase {

    // MARK: - IsoDay
    func testAnIsoDayReadsAndWritesTheServersText() {
        let day = IsoDay("2026-10-16")
        XCTAssertEqual(day, IsoDay(year: 2026, month: 10, day: 16))
        XCTAssertEqual(day?.text, "2026-10-16")
        XCTAssertEqual(IsoDay(year: 987, month: 3, day: 4).text, "0987-03-04")
    }

    func testAnIsoDayRefusesWhatIsNotARealDay() {
        for text in ["", "2026-10", "2026-1-05", "2026-10-5", "26-10-05", "2026-13-01", "2026-00-10", "2026-02-30",
                     "2025-02-29", "2026-04-31", "2026-10-00", "2026/10/16", "abcd-ef-gh", "2026-10-16T10:00"] {
            XCTAssertNil(IsoDay(text), "\(text) is not a day")
        }
        XCTAssertNotNil(IsoDay("2028-02-29"), "2028 is a leap year")
    }

    func testAnIsoDayAsADateIsTheSameDayInTheGregorianCalendar() {
        let date = IsoDay(year: 2026, month: 10, day: 16).date
        let parts = MonthGrid.gregorian.dateComponents([.year, .month, .day], from: date)
        XCTAssertEqual([parts.year, parts.month, parts.day], [2026, 10, 16])
    }

    // MARK: - MonthGrid
    func testAMonthKnowsItsLength() {
        XCTAssertEqual(MonthGrid.length(year: 2026, month: 1), 31)
        XCTAssertEqual(MonthGrid.length(year: 2026, month: 4), 30)
        XCTAssertEqual(MonthGrid.length(year: 2026, month: 2), 28)
        XCTAssertEqual(MonthGrid.length(year: 2028, month: 2), 29)
    }

    func testAMonthShiftsAcrossYears() {
        let october = MonthGrid(year: 2026, month: 10)
        XCTAssertEqual(october.shifted(by: 1), MonthGrid(year: 2026, month: 11))
        XCTAssertEqual(october.shifted(by: 3), MonthGrid(year: 2027, month: 1))
        XCTAssertEqual(MonthGrid(year: 2027, month: 1).shifted(by: -1), MonthGrid(year: 2026, month: 12))
        XCTAssertEqual(october.shifted(by: -10), MonthGrid(year: 2025, month: 12))
        XCTAssertEqual(october.shifted(by: 0), october)
    }

    /// October 2026 starts on a Thursday.
    func testTheGridStartsOnTheFirstWeekdayOfTheCalendar() {
        let october = MonthGrid(year: 2026, month: 10)
        let monday = october.cells(firstWeekday: 2)
        XCTAssertEqual(monday.prefix(5).map { $0 ?? 0 }, [0, 0, 0, 1, 2])
        let sunday = october.cells(firstWeekday: 1)
        XCTAssertEqual(sunday.prefix(5).map { $0 ?? 0 }, [0, 0, 0, 0, 1])
    }

    func testTheGridHoldsEveryDayOnceAndWholeWeeks() {
        for (year, month) in [(2026, 2), (2026, 10), (2027, 8), (2028, 2)] {
            for firstWeekday in 1...7 {
                let cells = MonthGrid(year: year, month: month).cells(firstWeekday: firstWeekday)
                XCTAssertEqual(cells.count % 7, 0)
                XCTAssertEqual(cells.compactMap { $0 }, Array(1...MonthGrid.length(year: year, month: month)))
            }
        }
    }

    func testAFebruaryOfFourWeeksStartingOnTheFirstWeekdayHasNoPadding() {
        // 1 February 2027 is a Monday and the month has 28 days.
        let cells = MonthGrid(year: 2027, month: 2).cells(firstWeekday: 2)
        XCTAssertEqual(cells.count, 28)
        XCTAssertEqual(cells.first, 1)
    }

    func testTheTitleNamesTheMonthAndTheYear() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US")
        XCTAssertEqual(MonthGrid(year: 2026, month: 10).title(calendar: calendar), "October 2026")
    }

    // MARK: - TimeOfDay
    func testATimeReadsOneOrTwoDigitHoursAndWritesTwo() {
        XCTAssertEqual(TimeOfDay("9:05"), TimeOfDay(hour: 9, minute: 5))
        XCTAssertEqual(TimeOfDay("14:30")?.text, "14:30")
        XCTAssertEqual(TimeOfDay(hour: 7, minute: 0).text, "07:00")
    }

    func testATimeRefusesWhatIsNotATimeOfDay() {
        for text in ["", "9", "24:00", "12:60", "12:5", "123:00", "-1:00", "ab:cd", "12:30:00"] {
            XCTAssertNil(TimeOfDay(text), "\(text) is not a time")
        }
    }

    func testTheMinuteWheelOffersEveryFifthMinuteAndTheCurrentOne() {
        XCTAssertEqual(TimeOfDay(hour: 9, minute: 30).minutes(), Array(stride(from: 0, to: 60, by: 5)))
        let odd = TimeOfDay(hour: 9, minute: 7).minutes()
        XCTAssertEqual(odd.count, 13)
        XCTAssertEqual(odd[1...2], [5, 7])
        XCTAssertEqual(TimeOfDay.hours.count, 24)
    }
}
