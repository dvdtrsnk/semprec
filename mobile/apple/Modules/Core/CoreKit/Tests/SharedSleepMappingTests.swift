import SharedSDK
import XCTest

@testable import CoreKit

/// The sleep bridge's state mappings: every branch over Kotlin values built here. Both modules declare these type
/// names, so each is qualified with its module.
final class SharedSleepMappingTests: XCTestCase {

    // MARK: - Mapping: state
    @MainActor
    func testStateMapsEveryValueOfAReadySheet() {
        let parts = SleepKotlin.Parts(
            plans: [SleepKotlin.plan()],
            night: SleepKotlin.night(reminder: 1350),
            editor: SleepKotlin.draft(planId: "p1", isNew: false),
            nightDraft: SleepKotlin.draft(planId: nil, isNew: false)
        )
        let state = SharedSleepScreenModel.state(SleepKotlin.state(phase: .ready, screen: .night, parts: parts))

        XCTAssertEqual(state.phase, .ready)
        XCTAssertEqual(state.page, .night)
        XCTAssertEqual(state.alarmSound, .piano)
        XCTAssertEqual(state.goalMinutes, 480)
        XCTAssertEqual(state.goalOptions, [450, 480])
        XCTAssertEqual(state.reminderLeadOptions, [30, 45])
        XCTAssertEqual(
            state.plans,
            [CoreKit.SleepPlanItem(
                id: "p1", name: "Weekdays", wakeDays: [1, 2, 3], bedMinutes: 1380, wakeMinutes: 405,
                durationMinutes: 465, alarm: true
            )]
        )
        XCTAssertEqual(
            state.night,
            CoreKit.SleepNightItem(
                night: "2026-10-16", planName: "Weekdays", bedMinutes: 1380, wakeMinutes: 405,
                durationMinutes: 465, alarm: true, changed: false, reminderMinutes: 1350
            )
        )
        XCTAssertEqual(state.editor, SleepKotlin.mappedDraft(planId: "p1", isNew: false))
        XCTAssertEqual(state.nightDraft, SleepKotlin.mappedDraft(planId: nil, isNew: false))
        XCTAssertTrue(state.saving)
        XCTAssertTrue(state.saveFailed)
        XCTAssertEqual(state.saveFailure, .rejected)
    }

    @MainActor
    func testStateMapsAbsentOptionalValues() {
        let state = SharedSleepScreenModel.state(SleepKotlin.state(phase: .loading, screen: .main, saveFailure: nil))

        XCTAssertEqual(state.phase, .loading)
        XCTAssertNil(state.night)
        XCTAssertNil(state.editor)
        XCTAssertNil(state.nightDraft)
        XCTAssertNil(state.saveFailure)
        XCTAssertTrue(state.plans.isEmpty)
    }

    @MainActor
    func testStateMapsANewPlanDraftWithoutAnId() {
        let parts = SleepKotlin.Parts(editor: SleepKotlin.draft(planId: nil, isNew: true))
        let state = SharedSleepScreenModel.state(SleepKotlin.state(phase: .ready, screen: .main, parts: parts))

        XCTAssertEqual(state.editor, SleepKotlin.mappedDraft(planId: nil, isNew: true))
        XCTAssertNil(state.editor?.planId)
        XCTAssertEqual(state.editor?.isNew, true)
    }

    @MainActor
    func testStateMapsADraftThatCannotBeSavedOrDeletedAndMissesTheGoal() {
        let draft = SharedSDK.SleepDraft(
            planId: "p1", isNew: false, wakeDays: [], takenDays: [], bedMinutes: 1380, wakeMinutes: 0,
            durationMinutes: 60, goalDifferenceMinutes: -420, meetsGoal: false, alarm: false, canSave: false,
            canDelete: false, stepMinutes: 5
        )
        let parts = SleepKotlin.Parts(editor: draft)
        let state = SharedSleepScreenModel.state(SleepKotlin.state(phase: .ready, screen: .main, parts: parts))

        XCTAssertEqual(state.editor?.wakeDays, [])
        XCTAssertEqual(state.editor?.meetsGoal, false)
        XCTAssertEqual(state.editor?.alarm, false)
        XCTAssertEqual(state.editor?.canSave, false)
        XCTAssertEqual(state.editor?.canDelete, false)
        XCTAssertEqual(state.editor?.goalDifferenceMinutes, -420)
    }

    @MainActor
    func testStateMapsANightWithoutAPlanOrReminder() {
        let night = SharedSDK.SleepNightItem(
            night: "2026-10-17", planName: nil, bedMinutes: 1380, wakeMinutes: 420, durationMinutes: 480,
            alarm: false, changed: true, reminderMinutes: nil
        )
        let state = SharedSleepScreenModel.state(
            SleepKotlin.state(phase: .ready, screen: .night, parts: SleepKotlin.Parts(night: night))
        )

        XCTAssertEqual(state.night?.planName, nil)
        XCTAssertEqual(state.night?.reminderMinutes, nil)
        XCTAssertEqual(state.night?.changed, true)
    }

    @MainActor
    func testStateMapsEachPhaseAndFailure() {
        func phase(_ phase: SharedSDK.SleepPhase, _ failure: SharedSDK.FailureKind?) -> CoreKit.SleepState.Phase {
            SharedSleepScreenModel.state(SleepKotlin.state(phase: phase, screen: .main, failure: failure)).phase
        }

        XCTAssertEqual(phase(.loading, nil), .loading)
        XCTAssertEqual(phase(.ready, nil), .ready)
        XCTAssertEqual(phase(.error, .unavailable), .failure(.unavailable))
        XCTAssertEqual(phase(.error, nil), .failure(nil))
    }

    @MainActor
    func testEveryPageSoundSwitchAndDialHandleRoundTrips() {
        for page in [SleepPage.main, .night, .remind, .sound, .goal] {
            XCTAssertEqual(SleepPage(page.shared), page)
        }
        for sound in CoreKit.SleepAlarmSound.allCases {
            XCTAssertEqual(CoreKit.SleepAlarmSound(sound.shared), sound)
        }
        XCTAssertEqual(CoreKit.SleepSwitch.enabled.shared, .enabled)
        XCTAssertEqual(CoreKit.SleepSwitch.showInCalendar.shared, .showInCalendar)
        XCTAssertEqual(CoreKit.SleepSwitch.muteSemp.shared, .muteSemp)
        XCTAssertEqual(CoreKit.SleepSwitch.alarmSnooze.shared, .alarmSnooze)
        XCTAssertEqual(CoreKit.SleepSwitch.prepReminder.shared, .prepReminder)
        XCTAssertEqual(CoreKit.SleepDialHandle.bed.shared, .bed)
        XCTAssertEqual(CoreKit.SleepDialHandle.wake.shared, .wake)
        XCTAssertEqual(CoreKit.SleepDialHandle.whole.shared, .whole)
        XCTAssertEqual(CoreKit.SleepMinutesChoice.reminderLead.shared, .reminderLead)
        XCTAssertEqual(CoreKit.SleepMinutesChoice.goal.shared, .goal)
    }
}
