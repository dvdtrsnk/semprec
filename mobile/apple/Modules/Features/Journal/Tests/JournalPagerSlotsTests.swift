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
