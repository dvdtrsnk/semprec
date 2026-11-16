import CoreKit

/// How the Account feature asks the app to show something. The app owns every stack and sheet.
@MainActor
public protocol AccountRouting: AnyObject {

    /// The person opened a row of the profile.
    func show(_ page: AccountPage)
}

/// A router for previews: it opens nothing.
@MainActor
final class PreviewAccountRouter: AccountRouting {

    // MARK: - Protocol conformance
    func show(_ page: AccountPage) {}
}
