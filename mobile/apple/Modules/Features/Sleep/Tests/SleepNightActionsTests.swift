import CoreKit
import XCTest

@testable import SleepFeature

/// What the night view sends: a night without a confirm button writes its draft when a drag ends or the alarm switches.
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
}

// MARK: - Support
private final class Recorder {

    private(set) var actions: [SleepAction] = []

    func record(_ action: SleepAction) {
        actions.append(action)
    }
}
