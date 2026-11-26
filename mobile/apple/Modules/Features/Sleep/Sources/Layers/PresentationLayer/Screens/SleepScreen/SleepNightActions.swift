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
