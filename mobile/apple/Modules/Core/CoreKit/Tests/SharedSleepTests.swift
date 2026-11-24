import SharedSDK
import XCTest

@testable import CoreKit

/// The sleep bridge: every branch of its mappings over Kotlin values built here, and the real Kotlin ViewModel behind
/// it. Both modules declare these type names, so each is qualified with its module.
final class SharedSleepTests: XCTestCase {

    // MARK: - Mapping: state
    @MainActor
    func testStateMapsEveryValueOfAReadySheet() {
        let parts = Parts(plans: [kotlinPlan()], night: kotlinNight(reminder: 1350), ring: kotlinRing())
        let state = SharedSleepScreenModel.state(sleepState(phase: .ready, screen: .plan, parts: parts))

        XCTAssertEqual(state.phase, .ready)
        XCTAssertEqual(state.page, .plan)
        XCTAssertEqual(state.alarmSound, .piano)
        XCTAssertEqual(state.goalMinutes, 480)
        XCTAssertEqual(state.goalOptions, [450, 480])
        XCTAssertEqual(state.reminderLeadOptions, [30, 45])
        XCTAssertEqual(state.selectedPlanID, "p1")
        XCTAssertEqual(state.takenDaysByOtherPlans, [6, 7])
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
        XCTAssertEqual(
            state.ring,
            CoreKit.SleepRing(
                bedMinutes: 1380, wakeMinutes: 405, durationMinutes: 465, goalDifferenceMinutes: -15, alarm: true
            )
        )
        XCTAssertTrue(state.canAddPlan)
        XCTAssertFalse(state.canDeletePlan)
        XCTAssertTrue(state.saving)
        XCTAssertTrue(state.saveFailed)
        XCTAssertEqual(state.saveFailure, .rejected)
    }

    @MainActor
    func testStateMapsAbsentOptionalValues() {
        let state = SharedSleepScreenModel.state(sleepState(phase: .loading, screen: .main, saveFailure: nil))

        XCTAssertEqual(state.phase, .loading)
        XCTAssertNil(state.night)
        XCTAssertNil(state.ring)
        XCTAssertNil(state.saveFailure)
        XCTAssertTrue(state.plans.isEmpty)
    }

    @MainActor
    func testStateMapsANightWithoutAPlanOrReminder() {
        let night = SharedSDK.SleepNightItem(
            night: "2026-10-17", planName: nil, bedMinutes: 1380, wakeMinutes: 420, durationMinutes: 480,
            alarm: false, changed: true, reminderMinutes: nil
        )
        let state = SharedSleepScreenModel.state(
            sleepState(phase: .ready, screen: .night, parts: Parts(night: night))
        )

        XCTAssertEqual(state.night?.planName, nil)
        XCTAssertEqual(state.night?.reminderMinutes, nil)
        XCTAssertEqual(state.night?.changed, true)
    }

    @MainActor
    func testStateMapsEachPhaseAndFailure() {
        func phase(_ phase: SharedSDK.SleepPhase, _ failure: SharedSDK.FailureKind?) -> CoreKit.SleepState.Phase {
            SharedSleepScreenModel.state(sleepState(phase: phase, screen: .main, failure: failure)).phase
        }

        XCTAssertEqual(phase(.loading, nil), .loading)
        XCTAssertEqual(phase(.ready, nil), .ready)
        XCTAssertEqual(phase(.error, .unavailable), .failure(.unavailable))
        XCTAssertEqual(phase(.error, nil), .failure(nil))
    }

    @MainActor
    func testEveryPageSoundAndSwitchRoundTrips() {
        for page in [SleepPage.main, .plan, .night, .remind, .sound, .goal] {
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
        XCTAssertEqual(CoreKit.SleepSwitch.alarm.shared, .alarm)
        XCTAssertEqual(CoreKit.SleepTimeField.bed.shared, .bed)
        XCTAssertEqual(CoreKit.SleepTimeField.wake.shared, .wake)
        XCTAssertEqual(CoreKit.SleepMinutesChoice.reminderLead.shared, .reminderLead)
        XCTAssertEqual(CoreKit.SleepMinutesChoice.goal.shared, .goal)
    }

    // MARK: - Mapping: action
    @MainActor
    func testEachActionMapsToItsKotlinAction() throws {
        XCTAssertEqual(SharedSleepScreenModel.action(.retry) as? NSObject, SharedSDK.SleepActionRetry.shared)
        XCTAssertEqual(SharedSleepScreenModel.action(.back) as? NSObject, SharedSDK.SleepActionBack.shared)
        XCTAssertEqual(SharedSleepScreenModel.action(.deletePlan) as? NSObject, SharedSDK.SleepActionDeletePlan.shared)
        XCTAssertEqual(SharedSleepScreenModel.action(.resetNight) as? NSObject, SharedSDK.SleepActionResetNight.shared)
        XCTAssertEqual(
            SharedSleepScreenModel.action(.dismissSaveFailure) as? NSObject,
            SharedSDK.SleepActionDismissSaveFailure.shared
        )

        let open = try XCTUnwrap(
            SharedSleepScreenModel.action(.open(.plan, planID: "p2")) as? SharedSDK.SleepActionOpen
        )
        XCTAssertEqual(open.screen, .plan)
        XCTAssertEqual(open.planId, "p2")

        let toggle = try XCTUnwrap(
            SharedSleepScreenModel.action(.setSwitch(.alarm, isOn: true)) as? SharedSDK.SleepActionSetSwitch
        )
        XCTAssertEqual(toggle.target, .alarm)
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

        let time = try XCTUnwrap(
            SharedSleepScreenModel.action(.setTime(.wake, minutes: 400)) as? SharedSDK.SleepActionSetTime
        )
        XCTAssertEqual(time.field, .wake)
        XCTAssertEqual(time.minutes, 400)

        let day = try XCTUnwrap(SharedSleepScreenModel.action(.toggleDay(6)) as? SharedSDK.SleepActionToggleDay)
        XCTAssertEqual(day.day, 6)

        let add = try XCTUnwrap(
            SharedSleepScreenModel.action(.addPlan(name: "Other")) as? SharedSDK.SleepActionAddPlan
        )
        XCTAssertEqual(add.name, "Other")

    }

    // MARK: - The real Kotlin ViewModel
    // Without a session the repository answers "unauthorized" without a request, so the bridge shows that failure.
    @MainActor
    func testTheRealViewModelFailsAsUnauthorizedWithoutASessionAndOpensOnTheNight() async throws {
        let model = isolatedFactory().makeSleep(night: "2026-10-16", startOnNight: true)

        let state = await waitForState(model) { $0.phase != .loading }

        XCTAssertEqual(state?.phase, .failure(.unauthorized))
        XCTAssertEqual(state?.page, .night)
        XCTAssertEqual(state?.isRoot, true)
    }

    @MainActor
    func testRetryMakesTheKotlinSleepViewModelLoadAgain() async throws {
        let model = try XCTUnwrap(
            isolatedFactory().makeSleep(night: nil, startOnNight: false) as? SharedSleepScreenModel
        )
        _ = await waitForState(model) { $0.phase != .loading }
        let loaded = model.viewModel.state.value

        model.send(.retry)

        XCTAssertFalse(model.viewModel.state.value === loaded, "Retry must start a new load of the Kotlin ViewModel")
        let reloaded = await waitForState(model) { $0.phase != .loading }
        XCTAssertEqual(reloaded?.phase, .failure(.unauthorized))
    }

    @MainActor
    func testReleasingTheBridgeClosesTheKotlinSleepViewModel() throws {
        var model: SharedSleepScreenModel? = try XCTUnwrap(
            isolatedFactory().makeSleep(night: nil, startOnNight: false) as? SharedSleepScreenModel
        )
        let viewModel = try XCTUnwrap(model?.viewModel)
        XCTAssertFalse(viewModel.isClosed)

        model = nil

        XCTAssertTrue(viewModel.isClosed)
    }

    // MARK: - Helpers
    private func kotlinPlan() -> SharedSDK.SleepPlanItem {
        SharedSDK.SleepPlanItem(
            id: "p1", name: "Weekdays", wakeDays: [1, 2, 3], bedMinutes: 1380, wakeMinutes: 405,
            durationMinutes: 465, alarm: true
        )
    }

    private func kotlinNight(reminder: Int32?) -> SharedSDK.SleepNightItem {
        SharedSDK.SleepNightItem(
            night: "2026-10-16", planName: "Weekdays", bedMinutes: 1380, wakeMinutes: 405,
            durationMinutes: 465, alarm: true, changed: false, reminderMinutes: reminder.map { KotlinInt(int: $0) }
        )
    }

    private func kotlinRing() -> SharedSDK.SleepRing {
        SharedSDK.SleepRing(
            bedMinutes: 1380, wakeMinutes: 405, durationMinutes: 465, goalDifferenceMinutes: -15, alarm: true
        )
    }

    /// What a Kotlin sleep state holds besides its phase, view and failures.
    private struct Parts {

        var plans: [SharedSDK.SleepPlanItem] = []
        var night: SharedSDK.SleepNightItem?
        var ring: SharedSDK.SleepRing?
    }

    private func sleepState(
        phase: SharedSDK.SleepPhase,
        screen: SharedSDK.SleepScreen,
        failure: SharedSDK.FailureKind? = nil,
        saveFailure: SharedSDK.FailureKind? = .rejected,
        parts: Parts = Parts()
    ) -> SharedSDK.SleepState {
        SharedSDK.SleepState(
            phase: phase,
            failure: failure,
            screen: screen,
            isRoot: true,
            enabled: true,
            showInCalendar: false,
            muteSemp: true,
            alarmSound: .piano,
            alarmSnooze: true,
            goalMinutes: 480,
            prepReminder: true,
            prepReminderMinutes: 30,
            goalOptions: [450, 480],
            reminderLeadOptions: [30, 45],
            plans: parts.plans,
            selectedPlanId: "p1",
            night: parts.night,
            ring: parts.ring,
            takenDaysByOtherPlans: [6, 7],
            canAddPlan: true,
            canDeletePlan: false,
            saving: true,
            saveFailed: true,
            saveFailure: saveFailure
        )
    }

    /// The first state of `model` that matches `predicate`, or `nil` when none arrives within five seconds.
    @MainActor
    private func waitForState<Model: ScreenModel>(
        _ model: Model,
        until predicate: @escaping @Sendable (Model.State) -> Bool
    ) async -> Model.State? {
        let found = Found<Model.State>()
        let matched = XCTestExpectation(description: "A matching state arrived")
        let observer = Task { @MainActor in
            for await state in model.states() where predicate(state) {
                found.value = state
                matched.fulfill()
                return
            }
        }
        _ = await XCTWaiter.fulfillment(of: [matched], timeout: 5)
        observer.cancel()
        return found.value
    }
}

// MARK: - Support
@MainActor
private final class Found<Value> {

    var value: Value?
}
