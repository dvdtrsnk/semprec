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

    /// The look of the app on this device, which needs no shared model.
    public static func appearance() -> some View {
        AppearanceScreen()
    }

    public static func devices(makeModel: @escaping @MainActor () -> any DevicesScreenModel) -> some View {
        DevicesScreen(viewModel: DevicesViewModel(model: makeModel()))
    }

    public static func notificationSettings(
        makeModel: @escaping @MainActor () -> any NotificationSettingsScreenModel,
        router: any AccountRouting
    ) -> some View {
        NotificationSettingsScreen(viewModel: NotificationSettingsViewModel(model: makeModel(), router: router))
    }

    public static func aiUsage(makeModel: @escaping @MainActor () -> any AiUsageScreenModel) -> some View {
        AiUsageScreen(viewModel: AiUsageViewModel(model: makeModel()))
    }

    public static func trash(makeModel: @escaping @MainActor () -> any TrashScreenModel) -> some View {
        TrashScreen(viewModel: TrashViewModel(model: makeModel()))
    }

    /// The internet accounts with their services, and the sheet that adds one.
    public static func internetAccounts(
        makeModel: @escaping @MainActor () -> any InternetAccountsScreenModel,
        router: any AccountRouting
    ) -> some View {
        InternetAccountsScreen(viewModel: InternetAccountsViewModel(model: makeModel(), router: router))
    }

    /// One internet account with its Mail and Calendars switches, its settings and its removal.
    public static func internetAccount(
        makeModel: @escaping @MainActor () -> any InternetAccountScreenModel,
        router: any AccountRouting
    ) -> some View {
        InternetAccountScreen(viewModel: InternetAccountViewModel(model: makeModel(), router: router))
    }
}
