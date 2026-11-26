import SharedSDK
import XCTest

@testable import CoreKit

/// The sleep bridge's action mappings: every Swift action to its Kotlin action. Both modules declare these type
/// names, so each is qualified with its module.
final class SharedSleepActionMappingTests: XCTestCase {

    // MARK: - Actions without a payload
    @MainActor
    func testTheActionsWithoutAPayloadMapToTheirKotlinObjects() {
        XCTAssertEqual(SharedSleepScreenModel.action(.retry) as? NSObject, SharedSDK.SleepActionRetry.shared)
        XCTAssertEqual(SharedSleepScreenModel.action(.back) as? NSObject, SharedSDK.SleepActionBack.shared)
        XCTAssertEqual(SharedSleepScreenModel.action(.resetNight) as? NSObject, SharedSDK.SleepActionResetNight.shared)
        XCTAssertEqual(
            SharedSleepScreenModel.action(.dismissSaveFailure) as? NSObject,
            SharedSDK.SleepActionDismissSaveFailure.shared
        )
        XCTAssertEqual(
            SharedSleepScreenModel.action(.draft(.deletePlan)) as? NSObject,
            SharedSDK.SleepActionDeleteDraftPlan.shared
        )
        XCTAssertEqual(
            SharedSleepScreenModel.action(.draft(.discard)) as? NSObject,
            SharedSDK.SleepActionDiscardDraft.shared
        )
        XCTAssertEqual(
            SharedSleepScreenModel.action(.draft(.commitNight)) as? NSObject,
            SharedSDK.SleepActionCommitNight.shared
        )
    }

    // MARK: - Navigation and settings
    @MainActor
    func testTheSheetActionsCarryTheirValues() throws {
        let open = try XCTUnwrap(SharedSleepScreenModel.action(.open(.night)) as? SharedSDK.SleepActionOpen)
        XCTAssertEqual(open.screen, .night)

        let toggle = try XCTUnwrap(
            SharedSleepScreenModel.action(.setSwitch(.muteSemp, isOn: true)) as? SharedSDK.SleepActionSetSwitch
        )
        XCTAssertEqual(toggle.target, .muteSemp)
        XCTAssertTrue(toggle.on)

        let minutes = try XCTUnwrap(
            SharedSleepScreenModel.action(.pickMinutes(.goal, minutes: 450)) as? SharedSDK.SleepActionPickMinutes
        )
        XCTAssertEqual(minutes.choice, .goal)
        XCTAssertEqual(minutes.minutes, 450)

        let sound = try XCTUnwrap(
            SharedSleepScreenModel.action(.pickSound(.birds)) as? SharedSDK.SleepActionPickSound
        )
        XCTAssertEqual(sound.sound, .birds)
    }

    // MARK: - Draft
    @MainActor
    func testEditingAPlanCarriesTheIdOrNone() throws {
        let edit = try XCTUnwrap(
            SharedSleepScreenModel.action(.draft(.editPlan(planID: "p2"))) as? SharedSDK.SleepActionEditPlan
        )
        XCTAssertEqual(edit.planId, "p2")

        let editNew = try XCTUnwrap(
            SharedSleepScreenModel.action(.draft(.editPlan(planID: nil))) as? SharedSDK.SleepActionEditPlan
        )
        XCTAssertNil(editNew.planId)
    }

    @MainActor
    func testMovingTheDialCarriesTheHandleAndTheMinutes() throws {
        for (handle, shared) in [
            (CoreKit.SleepDialHandle.bed, SharedSDK.SleepDialHandle.bed),
            (.wake, .wake),
            (.whole, .whole)
        ] {
            let action = SharedSleepScreenModel.action(.draft(.moveDial(handle, minutes: 1_395)))
            let move = try XCTUnwrap(action as? SharedSDK.SleepActionMoveDial)
            XCTAssertEqual(move.handle, shared)
            XCTAssertEqual(move.minutes, 1_395)
        }
    }

    @MainActor
    func testAMinuteOutsideTheIntegerRangeIsClampedAndNotTrapped() throws {
        let move = try XCTUnwrap(
            SharedSleepScreenModel.action(.draft(.moveDial(.bed, minutes: Int.max))) as? SharedSDK.SleepActionMoveDial
        )
        XCTAssertEqual(move.minutes, Int32.max)
    }

    @MainActor
    func testTheDaysTheAlarmAndTheConfirmationCarryTheirValues() throws {
        let day = try XCTUnwrap(
            SharedSleepScreenModel.action(.draft(.toggleDay(6))) as? SharedSDK.SleepActionToggleDraftDay
        )
        XCTAssertEqual(day.day, 6)

        let alarm = try XCTUnwrap(
            SharedSleepScreenModel.action(.draft(.setAlarm(isOn: true))) as? SharedSDK.SleepActionSetDraftAlarm
        )
        XCTAssertTrue(alarm.on)

        let confirm = try XCTUnwrap(
            SharedSleepScreenModel.action(.draft(.confirm(newPlanName: "Other"))) as? SharedSDK.SleepActionConfirmDraft
        )
        XCTAssertEqual(confirm.newPlanName, "Other")
    }
}
