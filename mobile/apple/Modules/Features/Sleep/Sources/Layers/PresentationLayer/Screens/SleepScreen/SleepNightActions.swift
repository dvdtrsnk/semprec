import CoreKit

/// What the night view sends when the person changes the night: the night has no confirm button, so a drag on the dial
/// that ends and a switch of the alarm each write the night's draft at once.
struct SleepNightActions {

    // MARK: - Dependencies
    let send: (SleepAction) -> Void

    // MARK: - Methods
    /// A drag on the dial ended: the draft the dial moved is written.
    func dragEnded() {
        send(.draft(.commitNight))
    }

    /// The alarm switch changed: the draft takes the alarm and is written.
    func setAlarm(_ isOn: Bool) {
        send(.draft(.setAlarm(isOn: isOn)))
        send(.draft(.commitNight))
    }
}

// MARK: - Editor
/// What the plan editor sends for the buttons of its toolbar and its form.
struct SleepEditorActions {

    // MARK: - Dependencies
    let draft: SleepDraft
    let send: (SleepAction) -> Void

    // MARK: - Methods
    /// Writes the draft; a new plan is named after its days, which the screen writes in the person's language.
    func confirm() {
        send(.draft(.confirm(newPlanName: SleepFormat.days(draft.wakeDays))))
    }

    func close() {
        send(.draft(.discard))
    }

    func delete() {
        send(.draft(.deletePlan))
    }

    func setAlarm(_ isOn: Bool) {
        send(.draft(.setAlarm(isOn: isOn)))
    }
}
