@preconcurrency internal import SharedSDK

/// The Kotlin `SleepViewModel` as a `SleepScreenModel`. Releasing the bridge closes the Kotlin ViewModel.
@MainActor
final class SharedSleepScreenModel {

    // MARK: - Dependencies
    /// Internal so that CoreKitTests can see what an action did to the Kotlin ViewModel's state.
    let viewModel: SharedSDK.SleepViewModel
    let lease: SharedViewModelLease

    // MARK: - Init
    init(_ viewModel: SharedSDK.SleepViewModel) {
        self.viewModel = viewModel
        lease = SharedViewModelLease { viewModel.close() }
    }

    deinit {
        lease.close()
    }
}

// MARK: - Protocol conformance
extension SharedSleepScreenModel: ScreenModel {

    var state: SleepState { Self.state(viewModel.state.value) }

    func states() -> AsyncStream<SleepState> {
        relay(viewModel.state, buffering: .bufferingNewest(1), Self.state)
    }

    /// The Kotlin ViewModel's effect type is `Nothing`, so the stream has no elements.
    func effects() -> AsyncStream<Never> {
        AsyncStream { $0.finish() }
    }

    func send(_ action: SleepAction) {
        viewModel.onAction(action: Self.action(action))
    }
}

// MARK: - Mapping
// Pure functions between the Kotlin and the Swift values, internal so that CoreKitTests check every branch with
// Kotlin values they build.
extension SharedSleepScreenModel {

    static func state(_ state: SharedSDK.SleepState) -> SleepState {
        SleepState(
            phase: phase(state),
            page: SleepPage(state.screen),
            isRoot: state.isRoot,
            enabled: state.enabled,
            showInCalendar: state.showInCalendar,
            muteSemp: state.muteSemp,
            alarmSound: SleepAlarmSound(state.alarmSound),
            alarmSnooze: state.alarmSnooze,
            goalMinutes: Int(state.goalMinutes),
            prepReminder: state.prepReminder,
            prepReminderMinutes: Int(state.prepReminderMinutes),
            goalOptions: state.goalOptions.map(\.intValue),
            reminderLeadOptions: state.reminderLeadOptions.map(\.intValue),
            plans: state.plans.map(SleepPlanItem.init),
            selectedPlanID: state.selectedPlanId,
            night: state.night.map(SleepNightItem.init),
            ring: state.ring.map(SleepRing.init),
            takenDaysByOtherPlans: state.takenDaysByOtherPlans.map(\.intValue),
            canAddPlan: state.canAddPlan,
            canDeletePlan: state.canDeletePlan,
            saving: state.saving,
            saveFailed: state.saveFailed,
            saveFailure: state.saveFailure.map(FailureKind.init)
        )
    }

    static func action(_ action: SleepAction) -> any SharedSDK.SleepAction {
        switch action {
        case .retry: SharedSDK.SleepActionRetry.shared
        case .open(let page, let planID): SharedSDK.SleepActionOpen(screen: page.shared, planId: planID)
        case .back: SharedSDK.SleepActionBack.shared
        case .setSwitch(let target, let isOn): SharedSDK.SleepActionSetSwitch(target: target.shared, on: isOn)
        case .pickMinutes(let choice, let minutes):
            SharedSDK.SleepActionPickMinutes(choice: choice.shared, minutes: Int32(minutes))
        case .pickSound(let sound): SharedSDK.SleepActionPickSound(sound: sound.shared)
        case .setTime(let field, let minutes):
            SharedSDK.SleepActionSetTime(field: field.shared, minutes: Int32(minutes))
        case .toggleDay(let day): SharedSDK.SleepActionToggleDay(day: Int32(day))
        case .addPlan(let name): SharedSDK.SleepActionAddPlan(name: name)
        case .deletePlan: SharedSDK.SleepActionDeletePlan.shared
        case let .savePlan(planID, name, wakeDays, bedMinutes, wakeMinutes, alarm):
            SharedSDK.SleepActionSavePlan(
                planId: planID,
                name: name,
                wakeDays: wakeDays.map { KotlinInt(int: Int32($0)) },
                bedMinutes: Int32(bedMinutes),
                wakeMinutes: Int32(wakeMinutes),
                alarm: alarm
            )
        case .removePlan(let planID): SharedSDK.SleepActionRemovePlan(planId: planID)
        case let .saveNight(bedMinutes, wakeMinutes, alarm):
            SharedSDK.SleepActionSaveNight(bedMinutes: Int32(bedMinutes), wakeMinutes: Int32(wakeMinutes), alarm: alarm)
        case .resetNight: SharedSDK.SleepActionResetNight.shared
        case .dismissSaveFailure: SharedSDK.SleepActionDismissSaveFailure.shared
        }
    }

    private static func phase(_ state: SharedSDK.SleepState) -> SleepState.Phase {
        switch state.phase {
        case .loading: .loading
        case .ready: .ready
        case .error: .failure(state.failure.map(FailureKind.init))
        }
    }
}
