import CoreKit
import XCTest

@testable import JournalFeature

final class JournalPagerSlotsTests: XCTestCase {

    // MARK: - Properties
    private let monday = JournalSelection(kind: .day, start: "2026-11-23")
    private let tuesday = JournalSelection(kind: .day, start: "2026-11-24")
    private let sunday = JournalSelection(kind: .day, start: "2026-11-22")

    // MARK: - What a slot shows
    func testTheLiveSlotShowsTheDiaryAndTheSlotsBesideItThePeriodsBesideIt() {
        let slots = JournalPagerSlots()
        let current = diary(showing: monday, before: sunday, after: tuesday)
        XCTAssertEqual(slots.state(of: 1, current: current, held: nil)?.shown, monday)
        XCTAssertEqual(slots.state(of: 0, current: current, held: nil)?.shown, sunday)
        XCTAssertEqual(slots.state(of: 2, current: current, held: nil)?.shown, tuesday)
    }

    func testASlotBesideAPeriodNotReadYetShowsNothing() {
        let slots = JournalPagerSlots()
        let current = diary(showing: monday, before: nil, after: nil)
        XCTAssertNil(slots.state(of: 0, current: current, held: nil))
        XCTAssertNil(slots.state(of: 2, current: current, held: nil))
    }

    func testAHeldPageIsShownInPlaceOfTheDiaryAndSoAreItsNeighbours() {
        let slots = JournalPagerSlots()
        let held = diary(showing: monday, before: sunday, after: tuesday)
        let current = diary(showing: tuesday, before: monday, after: nil)
        XCTAssertEqual(slots.state(of: 1, current: current, held: held)?.shown, monday)
        XCTAssertEqual(slots.state(of: 2, current: current, held: held)?.shown, tuesday)
    }

    // MARK: - The page drawn beside the view
    func testTheNextPageIsDrawnWhenTheSlotOnItsSideShowsIt() {
        let slots = JournalPagerSlots()
        let current = diary(showing: monday, before: sunday, after: tuesday)
        XCTAssertEqual(slots.drawn(steps: 1, target: tuesday, current: current, held: nil)?.shown, tuesday)
        XCTAssertEqual(slots.drawn(steps: -1, target: sunday, current: current, held: nil)?.shown, sunday)
        XCTAssertNil(slots.drawn(steps: 1, target: sunday, current: current, held: nil), "Another period")
    }

    func testNoPageIsDrawnWhileATurnIsUnderWay() {
        var slots = JournalPagerSlots()
        let current = diary(showing: monday, before: sunday, after: tuesday)
        XCTAssertTrue(slots.begin(UUID(), steps: 1, leaving: current, ready: nil))
        XCTAssertNil(slots.drawn(steps: 1, target: tuesday, current: current, held: nil))
    }

    // MARK: - A turn
    func testATurnKeepsTheLeavingPageAndShowsTheReadyOneUntilTheDiaryCatchesUp() {
        var slots = JournalPagerSlots()
        let leaving = diary(showing: monday, before: sunday, after: tuesday)
        let ready = leaving.showing(JournalPeriodContent(shown: tuesday))
        let id = UUID()
        XCTAssertTrue(slots.begin(id, steps: 1, leaving: leaving, ready: ready))
        XCTAssertEqual(slots.turning, id)
        XCTAssertEqual(slots.liveSlot, 2)
        // The diary still shows Monday: the slots keep what they were drawn with.
        XCTAssertEqual(slots.state(of: 1, current: leaving, held: nil)?.shown, monday)
        XCTAssertEqual(slots.state(of: 2, current: leaving, held: nil)?.shown, tuesday)
        // Once the diary shows Tuesday, the live slot shows the diary.
        let caughtUp = diary(showing: tuesday, before: monday, after: nil)
        XCTAssertEqual(slots.state(of: 2, current: caughtUp, held: nil), caughtUp)
    }

    func testSettlingMovesTheSlotsRoundAndKeepsNothing() {
        var slots = JournalPagerSlots()
        let leaving = diary(showing: monday, before: sunday, after: tuesday)
        XCTAssertTrue(slots.begin(UUID(), steps: 1, leaving: leaving, ready: nil))
        slots.settle(movedBy: 1)
        XCTAssertNil(slots.turning)
        XCTAssertEqual(slots.places, [1, -1, 0])
        XCTAssertEqual(slots.liveSlot, 2)
        XCTAssertTrue(slots.kept.isEmpty)
        // The slot that left the view is now after it and shows the next period of the new day.
        let next = JournalSelection(kind: .day, start: "2026-11-25")
        let current = diary(showing: tuesday, before: monday, after: next)
        XCTAssertEqual(slots.state(of: 0, current: current, held: nil)?.shown, next)
        XCTAssertEqual(slots.state(of: 1, current: current, held: nil)?.shown, monday)
    }

    func testTurningBackAfterATurnFindsTheSlotOnTheOtherSide() {
        var slots = JournalPagerSlots()
        let start = diary(showing: monday, before: sunday, after: tuesday)
        XCTAssertTrue(slots.begin(UUID(), steps: 1, leaving: start, ready: nil))
        slots.settle(movedBy: 1)
        XCTAssertTrue(slots.begin(UUID(), steps: -1, leaving: start, ready: nil))
        XCTAssertEqual(slots.liveSlot, 1)
        slots.settle(movedBy: -1)
        XCTAssertEqual(slots.places, [-1, 0, 1])
    }

    func testATurnFurtherThanOneSlotFindsNoSlot() {
        var slots = JournalPagerSlots()
        let start = diary(showing: monday, before: sunday, after: tuesday)
        XCTAssertFalse(slots.begin(UUID(), steps: 2, leaving: start, ready: nil))
        XCTAssertNil(slots.turning)
        XCTAssertEqual(slots.liveSlot, 1)
    }

    // MARK: - Helpers
    private func diary(
        showing shown: JournalSelection,
        before: JournalSelection?,
        after: JournalSelection?
    ) -> JournalState {
        JournalState(
            phase: .content,
            selection: shown,
            today: "2026-11-24",
            shown: shown,
            before: before.map { JournalPeriodContent(shown: $0) },
            after: after.map { JournalPeriodContent(shown: $0) }
        )
    }
}

final class JournalPickTurnTests: XCTestCase {

    private let leaving = JournalState(
        phase: .content, selection: JournalSelection(kind: .day, start: "2026-11-23"), today: "2026-11-24"
    )

    func testALaterPeriodOfTheSelectedKindTurnsForwardAndAnEarlierOneBack() throws {
        let monday = JournalSelection(kind: .day, start: "2026-11-23")
        let forward = try XCTUnwrap(JournalPageTurnRequest(
            picking: cell(.day, "2026-11-25"), from: monday, after: nil, leaving: leaving
        ))
        XCTAssertEqual(forward.steps, 1)
        XCTAssertEqual(forward.id, 1)
        XCTAssertEqual(forward.target, JournalSelection(kind: .day, start: "2026-11-25"))
        XCTAssertEqual(forward.leaving, leaving)
        let back = try XCTUnwrap(JournalPageTurnRequest(
            picking: cell(.day, "2026-10-31"), from: monday, after: forward, leaving: leaving
        ))
        XCTAssertEqual(back.steps, -1)
        XCTAssertEqual(back.id, 2, "Each turn is told apart from the one before")
    }

    func testTheSelectedPeriodOrOneOfAnotherKindTurnsNothing() {
        let month = JournalSelection(kind: .month, start: "2026-11-01")
        for picked in [cell(.month, "2026-11-01"), cell(.year, "2027-01-01"), cell(.day, "2026-11-05")] {
            let request = JournalPageTurnRequest(picking: picked, from: month, after: nil, leaving: leaving)
            XCTAssertNil(request, picked.start)
        }
    }

    func testMonthsAndYearsTurnAcrossTheEndOfTheYear() throws {
        let december = JournalSelection(kind: .month, start: "2026-12-01")
        let january = try XCTUnwrap(JournalPageTurnRequest(
            picking: cell(.month, "2027-01-01"), from: december, after: nil, leaving: leaving
        ))
        XCTAssertEqual(january.steps, 1)
        let year = JournalSelection(kind: .year, start: "2026-01-01")
        let earlier = try XCTUnwrap(JournalPageTurnRequest(
            picking: cell(.year, "2025-01-01"), from: year, after: nil, leaving: leaving
        ))
        XCTAssertEqual(earlier.steps, -1)
    }

    private func cell(_ kind: JournalPeriodKind, _ start: String) -> JournalAxisCell {
        let parts = start.split(separator: "-").compactMap { Int($0) }
        return JournalAxisCell(
            kind: kind, start: start, year: parts[0], quarter: (parts[1] - 1) / 3 + 1,
            month: parts[1], day: parts[2],
            weekday: 1, onPath: false, current: false, today: false
        )
    }
}

@MainActor
final class JournalAxisDayCountTests: XCTestCase {

    func testDaysAreCountedFromTheFirstOfJanuary1970() {
        XCTAssertEqual(JournalAxisTrack.epochDay(year: 1970, month: 1, day: 1), 0)
        XCTAssertEqual(JournalAxisTrack.epochDay(year: 1970, month: 1, day: 2), 1)
        XCTAssertEqual(JournalAxisTrack.epochDay(year: 1969, month: 12, day: 31), -1)
        XCTAssertEqual(JournalAxisTrack.epochDay(year: 2000, month: 1, day: 1), 10_957)
        XCTAssertEqual(JournalAxisTrack.epochDay(year: 2026, month: 11, day: 24), 20_781)
    }

    func testJanuaryAndFebruaryCountFromTheYearBeforeAndLeapDaysAreKept() {
        XCTAssertEqual(daysBetween((2024, 2, 28), (2024, 3, 1)), 2, "2024 has a 29 February")
        XCTAssertEqual(daysBetween((2100, 2, 28), (2100, 3, 1)), 1, "2100 has none")
        XCTAssertEqual(daysBetween((2000, 2, 28), (2000, 3, 1)), 2, "2000 has one")
        XCTAssertEqual(daysBetween((2026, 12, 31), (2027, 1, 1)), 1)
    }

    private func daysBetween(_ first: (Int, Int, Int), _ second: (Int, Int, Int)) -> Int {
        JournalAxisTrack.epochDay(year: second.0, month: second.1, day: second.2)
            - JournalAxisTrack.epochDay(year: first.0, month: first.1, day: first.2)
    }

    func testEveryDayOfSomeYearsCountsBackToItsOwnKey() {
        for epochDay in stride(from: -800, through: 21_000, by: 37) {
            let key = JournalAxisTrack.key(Double(epochDay))
            XCTAssertEqual(JournalAxisTrack.epochDay(key), Double(epochDay), key)
        }
    }

    func testAKeyThatIsNoDayHasNoCount() {
        XCTAssertNil(JournalAxisTrack.epochDay("2026-11"))
        XCTAssertNil(JournalAxisTrack.epochDay("not a day"))
    }
}
