import CoreKit
import SwiftUI

/// The screens of the Sleep feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and owns
/// that model for as long as SwiftUI keeps the screen. The plan and the night are the same sheet: the caller decides
/// where it opens by the model it makes (`makeSleep(night:startOnNight:)`), and the sheet closes itself through the
/// environment. It asks its `router` to open the wake settings, which are a sheet of their own.
@MainActor
public enum SleepScreenFactory {

    // MARK: - Screens
    /// The sleep plan sheet, which opens on the plan overview. A `night` given to `makeSleep` shows that night's ring.
    public static func plan(
        makeModel: @escaping @MainActor () -> any SleepScreenModel,
        router: any SleepRouting
    ) -> some View {
        SleepScreen(viewModel: SleepViewModel(model: makeModel(), router: router))
    }

    /// The sheet of one night, which opens on that night (`makeSleep(night:startOnNight: true)`); the plan overview
    /// is one step in.
    public static func night(
        makeModel: @escaping @MainActor () -> any SleepScreenModel,
        router: any SleepRouting
    ) -> some View {
        SleepScreen(viewModel: SleepViewModel(model: makeModel(), router: router))
    }

    /// The wake settings of this device. The sheet closes itself through the environment.
    public static func wakeSettings(makeModel: @escaping @MainActor () -> any WakeSettingsScreenModel) -> some View {
        WakeSettingsScreen(viewModel: WakeSettingsViewModel(model: makeModel()))
    }
}
