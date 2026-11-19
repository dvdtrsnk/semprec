import CoreKit
import XCTest

@testable import CalendarFeature

final class NewItemFormOptionsTests: XCTestCase {

    // MARK: - Tests
    func testAnEventDraftCarriesItsNotesLinkAlertTravelRepeatAndLaterEndDay() {
        var form = makeForm()
        form.title = "Trip"
        form.endDay = "2026-10-18"
        form.notes = " Map "
        form.url = " https://example.com "
        form.alertMinutes = 25
        form.travelMinutes = 45
        form.repeatRule = .weekly
        form.flagged = true
        let draft = form.draft
        XCTAssertEqual(draft.endDay, "2026-10-18")
        XCTAssertEqual(draft.notes, "Map")
        XCTAssertEqual(draft.url, "https://example.com")
        XCTAssertEqual(draft.alertMinutes, 25)
        XCTAssertEqual(draft.travelMinutes, 45)
        XCTAssertEqual(draft.repeatRule, .weekly)
        XCTAssertFalse(draft.flagged)
    }

    func testAnEventEndingOnItsFirstDaySendsNoEndDay() {
        var form = makeForm()
        form.title = "Lunch"
        XCTAssertEqual(form.draft.endDay, "")
    }

    func testATaskDraftKeepsNotesFlagAndRepeatAndDropsWhatBelongsToAnEvent() {
        var form = makeForm()
        form.kind = .task
        form.title = "Water plants"
        form.endDay = "2026-10-18"
        form.url = "https://example.com"
        form.alertMinutes = 25
        form.travelMinutes = 45
        form.repeatRule = .yearly
        form.flagged = true
        let draft = form.draft
        XCTAssertEqual(draft.endDay, "")
        XCTAssertEqual(draft.url, "")
        XCTAssertNil(draft.alertMinutes)
        XCTAssertNil(draft.travelMinutes)
        XCTAssertEqual(draft.repeatRule, .yearly)
        XCTAssertTrue(draft.flagged)
    }

    func testAnEndBeforeTheStartCannotBeSubmitted() {
        var form = makeForm()
        form.title = "Lunch"
        form.endMinutes = form.startMinutes
        XCTAssertTrue(form.endsBeforeStart)
        XCTAssertFalse(form.canSubmit)
        form.endDay = "2026-10-17"
        XCTAssertFalse(form.endsBeforeStart)
        form.endDay = "2026-10-15"
        XCTAssertTrue(form.endsBeforeStart)
        form.kind = .task
        XCTAssertFalse(form.endsBeforeStart)
        XCTAssertTrue(form.canSubmit)
    }

    func testMovingTheFirstDayKeepsTheEventsLength() {
        var form = makeForm()
        form.endDay = "2026-10-18"
        form.moveDay(to: "2026-10-30", calendar: utc)
        XCTAssertEqual(form.day, "2026-10-30")
        XCTAssertEqual(form.endDay, "2026-11-01")
    }

    func testAYearlyRepeatDropsWhenATaskBecomesAnEvent() {
        var form = makeForm()
        form.kind = .task
        form.repeatRule = .yearly
        form.fitRepeatToKind()
        XCTAssertEqual(form.repeatRule, .yearly)
        form.kind = .event
        form.fitRepeatToKind()
        XCTAssertEqual(form.repeatRule, .never)
        form.repeatRule = .monthly
        form.fitRepeatToKind()
        XCTAssertEqual(form.repeatRule, .monthly)
    }

    func testAlertsAndTravelTimesAreNamedInWords() {
        XCTAssertEqual(NewItemOptions.alertName(nil, allDay: false), "None")
        XCTAssertEqual(NewItemOptions.alertName(0, allDay: false), "At time of event")
        XCTAssertEqual(NewItemOptions.alertName(0, allDay: true), "On day of event (9:00)")
        XCTAssertTrue(NewItemOptions.alertName(90, allDay: false).hasSuffix("before"))
        XCTAssertEqual(NewItemOptions.travelName(nil), "None")
        XCTAssertTrue(NewItemOptions.alertRange.contains(40_320))
        XCTAssertFalse(NewItemOptions.travelRange.contains(0))
    }

    // MARK: - Private
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }

    private func makeForm() -> NewItemForm {
        let now = utc.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 9)) ?? Date()
        return NewItemForm(day: "2026-10-16", now: now, calendar: utc)
    }
}
