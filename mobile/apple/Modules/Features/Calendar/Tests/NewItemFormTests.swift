import CoreKit
import XCTest

@testable import CalendarFeature

final class NewItemFormTests: XCTestCase {

    // MARK: - Tests
    func testStartsAtTheNextFullHourAndLastsAnHour() {
        let form = NewItemForm(day: "2026-10-16", now: at(hour: 9, minute: 30), calendar: utc)
        XCTAssertEqual(form.day, "2026-10-16")
        XCTAssertEqual(form.startMinutes, 600)
        XCTAssertEqual(form.endMinutes, 660)
        XCTAssertEqual(form.kind, .event)
        XCTAssertTrue(form.timed)
        XCTAssertTrue(form.hasEnd)
    }

    func testTheDefaultStartStaysEarlyEnoughForItsEndToFitTheDay() {
        let form = NewItemForm(day: "2026-10-16", now: at(hour: 23, minute: 10), calendar: utc)
        XCTAssertEqual(form.startMinutes, NewItemForm.latestDefaultStart)
        XCTAssertEqual(form.endMinutes, NewItemForm.latestDefaultStart + 60)
    }

    func testOnlyATitleWithTextCanBeSubmitted() {
        var form = makeForm()
        XCTAssertFalse(form.canSubmit)
        form.title = "  \n "
        XCTAssertFalse(form.canSubmit)
        form.title = " Standup "
        XCTAssertTrue(form.canSubmit)
    }

    func testAnEventDraftCarriesItsTrimmedValuesEndAndCalendar() {
        var form = makeForm()
        form.title = " Standup "
        form.place = " Karlín "
        form.calendarId = "work"
        XCTAssertEqual(
            form.draft,
            NewItemDraft(
                kind: .event, title: "Standup", day: "2026-10-16", timed: true, startMinutes: 600, hasEnd: true,
                endMinutes: 660, place: "Karlín", calendarId: "work"
            )
        )
    }

    func testAnEventWithoutATimeHasNoEnd() {
        var form = makeForm()
        form.title = "Holiday"
        form.timed = false
        XCTAssertFalse(form.draft.timed)
        XCTAssertFalse(form.draft.hasEnd)
    }

    func testAnEventWhoseEndIsOffHasNoEnd() {
        var form = makeForm()
        form.title = "Call"
        form.hasEnd = false
        XCTAssertTrue(form.draft.timed)
        XCTAssertFalse(form.draft.hasEnd)
    }

    func testATaskDraftHasNoEndPlaceOrCalendar() {
        var form = makeForm()
        form.kind = .task
        form.title = "Pay rent"
        form.place = "Bank"
        form.calendarId = "work"
        XCTAssertEqual(
            form.draft,
            NewItemDraft(
                kind: .task, title: "Pay rent", day: "2026-10-16", timed: true, startMinutes: 600, hasEnd: false,
                endMinutes: 660, place: "", calendarId: ""
            )
        )
    }

    func testMovingTheStartKeepsTheDuration() {
        var form = makeForm()
        form.endMinutes = 690
        form.moveStart(to: 840)
        XCTAssertEqual(form.startMinutes, 840)
        XCTAssertEqual(form.endMinutes, 930)
    }

    func testMovingTheStartLateStopsTheEndAtTheLastTimeOfTheDay() {
        var form = makeForm()
        form.moveStart(to: 23 * 60 + 30)
        XCTAssertEqual(form.endMinutes, NewItemForm.latestEnd)
    }

    func testAnEndBeforeTheStartBecomesAnHourAfterTheMovedStart() {
        var form = makeForm()
        form.endMinutes = 540
        form.moveStart(to: 720)
        XCTAssertEqual(form.endMinutes, 780)
    }

    func testDaysConvertToLocalMidnightsAndBack() throws {
        var pacific = Calendar(identifier: .gregorian)
        pacific.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let date = NewItemForm.date(ofDay: "2026-03-08", calendar: pacific)
        XCTAssertEqual(pacific.dateComponents([.hour, .minute], from: date), DateComponents(hour: 0, minute: 0))
        XCTAssertEqual(NewItemForm.day(of: date, calendar: pacific), "2026-03-08")
        XCTAssertEqual(NewItemForm.day(of: date.addingTimeInterval(23 * 3_600 - 1), calendar: pacific), "2026-03-08")
    }

    func testAKeyThatIsNoDayGivesToday() {
        let date = NewItemForm.date(ofDay: "soon", calendar: utc)
        XCTAssertEqual(date, utc.startOfDay(for: Date()))
    }

    func testTimesConvertToMinutesAndBack() {
        for minutes in [0, 545, 1_435] {
            let time = NewItemForm.time(minutes: minutes, calendar: utc)
            XCTAssertEqual(NewItemForm.minutes(of: time, calendar: utc), minutes)
        }
    }

    // MARK: - Helpers
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }

    private func at(hour: Int, minute: Int) -> Date {
        utc.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: hour, minute: minute)) ?? Date()
    }

    private func makeForm() -> NewItemForm {
        NewItemForm(day: "2026-10-16", now: at(hour: 9, minute: 0), calendar: utc)
    }
}
