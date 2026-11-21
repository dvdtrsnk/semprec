import CoreKit

/// How the Account feature asks the app to show something. The app owns every stack and sheet.
@MainActor
public protocol AccountRouting: AnyObject {

    /// The person opened a row of the profile.
    func show(_ page: AccountPage)

    /// One internet account; `accountId` is the id of its Mailboxes item.
    func showInternetAccount(accountId: String)

    /// The person turned a notification or an account's Calendars on: the app asks for the permission to notify,
    /// unless it was answered.
    func requestNotificationPermission()
}

/// A router for previews: it opens nothing.
@MainActor
final class PreviewAccountRouter: AccountRouting {

    // MARK: - Protocol conformance
    func show(_ page: AccountPage) {}

    func showInternetAccount(accountId: String) {}

    func requestNotificationPermission() {}
}
