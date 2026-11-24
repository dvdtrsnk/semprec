import CoreKit
import SwiftUI

/// The screens of the Sleep feature. A screen calls `makeModel` once, when SwiftUI creates its `@StateObject`, and owns
/// that model for as long as SwiftUI keeps the screen. Both are the same sheet: the caller decides where it opens
/// by the model it makes (`makeSleep(night:startOnNight:)`), and the sheet closes itself through the environment, so
/// it has no routing protocol.
@MainActor
public enum SleepScreenFactory {

    // MARK: - Screens
    /// The sleep plan sheet, which opens on the plan overview. `wakeSettings` is the screen of how the alarms wake
    /// the person on this device, which the overview opens over the sheet; without it the overview has no such row.
    public static func plan(
        makeModel: @escaping @MainActor () -> any SleepScreenModel,
        wakeSettings: (@MainActor () -> AnyView)? = nil
    ) -> some View {
        SleepScreen(viewModel: SleepViewModel(model: makeModel()), wakeSettings: wakeSettings)
    }

    /// The sheet of one night, which opens on that night (`makeSleep(night:startOnNight: true)`); the plan overview
    /// is one step in.
    public static func night(
        makeModel: @escaping @MainActor () -> any SleepScreenModel,
        wakeSettings: (@MainActor () -> AnyView)? = nil
    ) -> some View {
        SleepScreen(viewModel: SleepViewModel(model: makeModel()), wakeSettings: wakeSettings)
    }
}
