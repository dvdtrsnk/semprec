@preconcurrency internal import SharedSDK

// MARK: - Account
extension SharedScreenModelFactory {

    public func makeProfile() -> any ProfileScreenModel {
        SharedProfileScreenModel(sdk.account.profileViewModel())
    }

    public func makeDevices() -> any DevicesScreenModel {
        SharedDevicesScreenModel(sdk.account.devicesViewModel())
    }

    public func makeNotificationSettings() -> any NotificationSettingsScreenModel {
        SharedNotificationSettingsScreenModel(sdk.account.notificationSettingsViewModel())
    }

    public func makeAiUsage() -> any AiUsageScreenModel {
        SharedAiUsageScreenModel(sdk.account.aiUsageViewModel(today: { IsoDay.today() }))
    }

    public func makeTrash() -> any TrashScreenModel {
        SharedTrashScreenModel(sdk.account.trashViewModel())
    }

    public func makeInternetAccounts() -> any InternetAccountsScreenModel {
        SharedInternetAccountsScreenModel(sdk.mail.internetAccountsViewModel())
    }

    public func makeInternetAccount(accountId: String) -> any InternetAccountScreenModel {
        SharedInternetAccountScreenModel(sdk.mail.internetAccountViewModel(accountId: accountId))
    }
}
