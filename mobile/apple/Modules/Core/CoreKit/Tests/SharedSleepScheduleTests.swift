import SharedSDK
import XCTest

@testable import CoreKit

/// The schedule editor's actions on their way to the Kotlin sleep ViewModel.
final class SharedSleepScheduleTests: XCTestCase {

    func testSavingAScheduleMapsEveryField() throws {
        let save = try XCTUnwrap(
            SharedSleepScreenModel.action(
                .savePlan(
                    planID: nil,
                    name: "Weekend",
                    wakeDays: [6, 7],
                    bedMinutes: 1_425,
                    wakeMinutes: 435,
                    alarm: true
                )
            ) as? SharedSDK.SleepActionSavePlan
        )
        XCTAssertNil(save.planId)
        XCTAssertEqual(save.name, "Weekend")
        XCTAssertEqual(save.wakeDays.map(\.intValue), [6, 7])
        XCTAssertEqual(save.bedMinutes, 1_425)
        XCTAssertEqual(save.wakeMinutes, 435)
        XCTAssertTrue(save.alarm)

        let edit = try XCTUnwrap(
            SharedSleepScreenModel.action(
                .savePlan(planID: "p1", name: "", wakeDays: [1], bedMinutes: 0, wakeMinutes: 60, alarm: false)
            ) as? SharedSDK.SleepActionSavePlan
        )
        XCTAssertEqual(edit.planId, "p1")
        XCTAssertFalse(edit.alarm)
    }

    func testRemovingAPlanMapsItsID() throws {
        let remove = try XCTUnwrap(
            SharedSleepScreenModel.action(.removePlan(planID: "p2")) as? SharedSDK.SleepActionRemovePlan
        )
        XCTAssertEqual(remove.planId, "p2")
    }
}
