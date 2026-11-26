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
            night: state.night.map(SleepNightItem.init),
            editor: state.editor.map(SleepDraft.init),
            nightDraft: state.nightDraft.map(SleepDraft.init),
            saving: state.saving,
            saveFailed: state.saveFailed,
            saveFailure: state.saveFailure.map(FailureKind.init)
        )
    }

    static func action(_ action: SleepAction) -> any SharedSDK.SleepAction {
        switch action {
        case .retry: SharedSDK.SleepActionRetry.shared
        case .open(let page): SharedSDK.SleepActionOpen(screen: page.shared)
        case .back: SharedSDK.SleepActionBack.shared
        case .setSwitch(let target, let isOn): SharedSDK.SleepActionSetSwitch(target: target.shared, on: isOn)
        case .pickMinutes(let choice, let minutes):
            SharedSDK.SleepActionPickMinutes(choice: choice.shared, minutes: Int32(clamping: minutes))
        case .pickSound(let sound): SharedSDK.SleepActionPickSound(sound: sound.shared)
        case .draft(let draft): draftAction(draft)
        case .resetNight: SharedSDK.SleepActionResetNight.shared
        case .dismissSaveFailure: SharedSDK.SleepActionDismissSaveFailure.shared
        }
    }

    static func draftAction(_ action: SleepDraftAction) -> any SharedSDK.SleepAction {
        switch action {
        case .editPlan(let planID): SharedSDK.SleepActionDraftEditPlan(planId: planID)
        case .moveDial(let handle, let minutes):
            SharedSDK.SleepActionDraftMoveDial(handle: handle.shared, minutes: Int32(clamping: minutes))
        case .toggleDay(let day): SharedSDK.SleepActionDraftToggleDraftDay(day: Int32(clamping: day))
        case .setAlarm(let isOn): SharedSDK.SleepActionDraftSetDraftAlarm(on: isOn)
        case .confirm(let name): SharedSDK.SleepActionDraftConfirmDraft(newPlanName: name)
        case .deletePlan: SharedSDK.SleepActionDraftDeleteDraftPlan.shared
        case .discard: SharedSDK.SleepActionDraftDiscardDraft.shared
        case .commitNight: SharedSDK.SleepActionDraftCommitNight.shared
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
