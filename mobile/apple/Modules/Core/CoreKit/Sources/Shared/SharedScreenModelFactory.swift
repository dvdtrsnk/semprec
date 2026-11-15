@preconcurrency internal import SharedSDK

/// Creates the screen models from one Kotlin `HomeSDK`, which owns the data of one app scene.
@MainActor
public final class SharedScreenModelFactory {

    // MARK: - Dependencies
    private let sdk = SharedSDK.HomeSDK(sessionStorage: KeychainSessionStorage(), device: DeviceIdentity.current())

    // MARK: - Init
    public init() {}
}

// MARK: - Protocol conformance
extension SharedScreenModelFactory: ScreenModelFactory {

    public func makeHome() -> any HomeScreenModel {
        SharedHomeScreenModel(sdk.homeViewModel())
    }

    public func makeDetail(itemId: String) -> any DetailScreenModel {
        SharedDetailScreenModel(sdk.detailViewModel(itemId: itemId))
    }

    public func makeSettings() -> any SettingsScreenModel {
        SharedSettingsScreenModel(sdk.settingsViewModel())
    }

    public func makeSession() -> any SessionScreenModel {
        SharedSessionScreenModel(sdk.sessionViewModel())
    }

    public func makeLogin() -> any LoginScreenModel {
        SharedLoginScreenModel(sdk.loginViewModel())
    }

    // Journal slice
    public func makeJournal(initialDay: String) -> any JournalScreenModel {
        SharedJournalScreenModel(sdk.journalViewModel(initialDay: initialDay))
    }

    public func makeJournalSubpage(itemId: String) -> any JournalSubpageScreenModel {
        SharedJournalSubpageScreenModel(sdk.journalSubpageViewModel(itemId: itemId))
    }
}
