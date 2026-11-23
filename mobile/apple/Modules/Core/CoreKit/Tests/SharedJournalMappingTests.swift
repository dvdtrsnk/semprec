import SharedSDK
import XCTest

@testable import CoreKit

/// Checks every branch of the diary bridge's state mapping with Kotlin values built here.
@MainActor
final class SharedJournalMappingTests: XCTestCase {

    // MARK: - Phases
    func testStateMapsEveryPhase() {
        XCTAssertEqual(SharedJournalScreenModel.state(JournalKotlin.state(.loading)).phase, .loading)
        XCTAssertEqual(SharedJournalScreenModel.state(JournalKotlin.state(.content)).phase, .content)
        XCTAssertEqual(
            SharedJournalScreenModel.state(JournalKotlin.state(.error, failure: .unauthorized)).phase,
            .failure(.unauthorized)
        )
        XCTAssertEqual(SharedJournalScreenModel.state(JournalKotlin.state(.error)).phase, .failure(nil))
    }

    func testStateMapsSelectionAndToday() {
        let state = SharedJournalScreenModel.state(JournalKotlin.state(.content))
        XCTAssertEqual(state.selection, CoreKit.JournalSelection(kind: .month, start: "2026-10-01"))
        XCTAssertEqual(state.today, "2026-10-16")
        XCTAssertNil(state.page)
        XCTAssertEqual(state.weeks, [])
        XCTAssertEqual(state.quarters, [])
    }

    func testStateMapsTheShownPeriodOrItsAbsence() {
        XCTAssertNil(SharedJournalScreenModel.state(JournalKotlin.state(.loading)).shown)
        let shown = SharedSDK.JournalSelection(kind: .day, start: "2026-10-15")
        XCTAssertEqual(
            SharedJournalScreenModel.state(JournalKotlin.state(.content, shown: shown)).shown,
            CoreKit.JournalSelection(kind: .day, start: "2026-10-15")
        )
    }

    // MARK: - Content
    func testStateMapsThePageAndItsBlocks() {
        let ref = SharedSDK.JournalPageRef(kind: .day, period: "2026-10-16")
        let block = JournalKotlin.block(index: 2, kind: .todo, runs: [JournalKotlin.run("Boots", bold: true)])
        let state = SharedJournalScreenModel.state(JournalKotlin.state(
            .content, page: SharedSDK.JournalPageState(ref: ref, blocks: [block])
        ))
        XCTAssertEqual(state.page?.ref, CoreKit.JournalPageRef(kind: .day, period: "2026-10-16"))
        XCTAssertEqual(
            state.page?.blocks,
            [CoreKit.JournalBlock(
                index: 2, kind: .todo, indent: 1, done: true, ordinal: 0,
                runs: [CoreKit.JournalRun(text: "Boots", bold: true)]
            )]
        )
    }

    func testStateMapsAWeekWithItsPage() {
        let ref = SharedSDK.JournalPageRef(kind: .week, period: "2026-W42")
        let week = SharedSDK.JournalWeekState(
            number: 42, from: "2026-10-12", to: "2026-10-18",
            page: SharedSDK.JournalPageState(ref: ref, blocks: [])
        )
        let state = SharedJournalScreenModel.state(JournalKotlin.state(.content, weeks: [week]))
        XCTAssertEqual(state.weeks.first?.number, 42)
        XCTAssertEqual(state.weeks.first?.firstDay, "2026-10-12")
        XCTAssertEqual(state.weeks.first?.lastDay, "2026-10-18")
        XCTAssertEqual(state.weeks.first?.page.ref, CoreKit.JournalPageRef(kind: .week, period: "2026-W42"))
    }

    func testStateMapsAQuarterWithItsPage() {
        let ref = SharedSDK.JournalPageRef(kind: .quarter, period: "2026-Q4")
        let quarter = SharedSDK.JournalQuarterState(
            number: 4, from: "2026-10-01", to: "2026-12-31",
            page: SharedSDK.JournalPageState(ref: ref, blocks: [])
        )
        let state = SharedJournalScreenModel.state(JournalKotlin.state(.content, quarters: [quarter]))
        XCTAssertEqual(state.quarters.first?.number, 4)
        XCTAssertEqual(state.quarters.first?.firstDay, "2026-10-01")
        XCTAssertEqual(state.quarters.first?.lastDay, "2026-12-31")
        XCTAssertEqual(state.quarters.first?.page.ref, CoreKit.JournalPageRef(kind: .quarter, period: "2026-Q4"))
    }

    func testStateMapsEventsBirthdaysInboxAndAxis() {
        let inbox = SharedSDK.JournalInboxState(
            id: "i1", time: "08:15", text: "Idea", emoji: "x", status: .proposed,
            attachmentName: "scan.pdf", attachmentCount: 2
        )
        let state = SharedJournalScreenModel.state(JournalKotlin.state(
            .content,
            events: [JournalKotlin.event(start: 540, end: 570)],
            birthdays: [SharedSDK.JournalBirthdayState(id: "b1", personName: "Jana")],
            inbox: [inbox],
            axis: [SharedSDK.JournalAxisRowState(kind: .day, cells: [JournalKotlin.cell()])]
        ))
        XCTAssertEqual(state.events.first?.startMinutes, 540)
        XCTAssertEqual(state.events.first?.endMinutes, 570)
        XCTAssertEqual(state.events.first?.projectColor, "#007AFF")
        XCTAssertEqual(state.events.first?.hasTranscript, true)
        XCTAssertEqual(state.birthdays, [JournalBirthday(id: "b1", personName: "Jana")])
        XCTAssertEqual(state.inbox.first?.status, .proposed)
        XCTAssertEqual(state.inbox.first?.attachmentCount, 2)
        XCTAssertEqual(state.axis.first?.kind, .day)
        XCTAssertEqual(state.axis.first?.cells.first?.start, "2026-10-16")
        XCTAssertEqual(state.axis.first?.cells.first?.weekday, 5)
        XCTAssertEqual(state.axis.first?.cells.first?.current, true)
    }

    func testAnAllDayEventKeepsNoTimes() {
        let event = JournalEvent(JournalKotlin.event(allDay: true))
        XCTAssertNil(event.startMinutes)
        XCTAssertNil(event.endMinutes)
        XCTAssertTrue(event.allDay)
    }
}
