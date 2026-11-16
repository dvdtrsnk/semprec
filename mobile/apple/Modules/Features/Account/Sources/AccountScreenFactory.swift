import CoreKit
import SwiftUI

/// The screens of the Account feature: the profile and the screens below it. A screen calls `makeModel` once, when
/// SwiftUI creates its `@StateObject`, and owns that model for as long as SwiftUI keeps the screen.
@MainActor
public enum AccountScreenFactory {

    // MARK: - Screens
    public static func profile(
        makeModel: @escaping @MainActor () -> any ProfileScreenModel,
        router: any AccountRouting
    ) -> some View {
        ProfileScreen(viewModel: ProfileViewModel(model: makeModel(), router: router))
    }

    public static func devices(makeModel: @escaping @MainActor () -> any DevicesScreenModel) -> some View {
        DevicesScreen(viewModel: DevicesViewModel(model: makeModel()))
    }

    public static func notificationSettings(
        makeModel: @escaping @MainActor () -> any NotificationSettingsScreenModel
    ) -> some View {
        NotificationSettingsScreen(viewModel: NotificationSettingsViewModel(model: makeModel()))
    }

    public static func aiUsage(makeModel: @escaping @MainActor () -> any AiUsageScreenModel) -> some View {
        AiUsageScreen(viewModel: AiUsageViewModel(model: makeModel()))
    }

    public static func trash(makeModel: @escaping @MainActor () -> any TrashScreenModel) -> some View {
        TrashScreen(viewModel: TrashViewModel(model: makeModel()))
    }
}
