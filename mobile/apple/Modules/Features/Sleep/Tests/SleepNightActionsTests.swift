import CoreKit
import XCTest

@testable import SleepFeature

/// What the sleep views send: the night view writes its draft when a drag ends or the alarm switches, the dial's
/// accessibility controls move an end by one step, the plan editor's buttons send their intents, and a day has a role.
final class SleepNightActionsTests: XCTestCase {

    // MARK: - Tests
    func testTheEndOfADragWritesTheNight() {
        let sent = Recorder()
        SleepNightActions(send: sent.record).dragEnded()

        XCTAssertEqual(sent.actions, [.draft(.commitNight)])
    }

    func testSwitchingTheAlarmSetsItAndThenWritesTheNight() {
        let sent = Recorder()
        let actions = SleepNightActions(send: sent.record)

        actions.setAlarm(false)
        actions.setAlarm(true)

        XCTAssertEqual(
            sent.actions,
            [
                .draft(.setAlarm(isOn: false)), .draft(.commitNight),
                .draft(.setAlarm(isOn: true)), .draft(.commitNight)
            ]
        )
    }

    // MARK: - Dial
    func testAnAdjustmentMovesTheEndByOneStepAndThenEndsTheChange() {
        let sent = Recorder()
        var ended = 0
        let actions = SleepDialActions(send: sent.record, onEnd: { ended += 1 })

        actions.adjust(.bed, at: 1_380, stepMinutes: 5, isLater: true)
        actions.adjust(.wake, at: 405, stepMinutes: 5, isLater: false)

        XCTAssertEqual(
            sent.actions,
            [.draft(.moveDial(.bed, minutes: 1_385)), .draft(.moveDial(.wake, minutes: 400))]
        )
        XCTAssertEqual(ended, 2)
    }

    // MARK: - Editor
    func testTheEditorButtonsSendTheirIntents() {
        let sent = Recorder()
        let actions = SleepEditorActions(draft: .previewWeekdays, send: sent.record)

        actions.confirm()
        actions.close()
        actions.delete()
        actions.setAlarm(false)

        XCTAssertEqual(
            sent.actions,
            [
                .draft(.confirm(newPlanName: "Mon–Fri")), .draft(.discard), .draft(.deletePlan),
                .draft(.setAlarm(isOn: false))
            ]
        )
    }

    func testANewPlanIsNamedAfterItsDays() {
        let sent = Recorder()

        SleepEditorActions(draft: .previewNew, send: sent.record).confirm()

        XCTAssertEqual(sent.actions, [.draft(.confirm(newPlanName: "Sat, Sun"))])
    }

    // MARK: - Days
    func testADayIsSelectedHeldByAnotherPlanOrFree() {
        let draft = SleepDraft.previewWeekdays

        XCTAssertEqual(draft.role(of: 1), .selected)
        XCTAssertEqual(draft.role(of: 6), .heldByAnotherPlan)
        XCTAssertEqual(SleepDraft.previewNew.role(of: 6), .selected)
        XCTAssertEqual(SleepDraft.previewNight.role(of: 3), .free)
    }
}

// MARK: - Support
private final class Recorder {

    private(set) var actions: [SleepAction] = []

    func record(_ action: SleepAction) {
        actions.append(action)
    }
}
