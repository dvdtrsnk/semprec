import AuthFeature
import CoreKit
import Foundation
import SwiftUI

/// Opens the "Set a new password" sheet over the window for a password-reset link the system hands the app, signed in
/// or not. Any other address is ignored, and so is a link that arrives while the wake guard blocks the window's
/// navigation. The sheets of the window's stacks are closed first, because a sheet cannot be presented over another.
struct PasswordResetLinks: ViewModifier {

    // MARK: - Dependencies
    let models: any ScreenModelFactory
    let navigation: NavigationContext

    // MARK: - State
    @State private var link: PasswordResetLink?

    // MARK: - Body
    func body(content: Content) -> some View {
        let models = models
        content
            .onOpenURL { open($0) }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL { open(url) }
            }
            .sheet(item: $link) { link in
                AuthScreenFactory.passwordReset {
                    models.makePasswordReset(serverUrl: link.serverUrl, token: link.token)
                }
            }
    }
}

// MARK: - Private
private extension PasswordResetLinks {

    func open(_ url: URL) {
        guard !navigation.isBlocked, let opened = PasswordResetLink(url: url) else { return }
        navigation.dismissAllPresented()
        link = opened
    }
}

// MARK: - View
extension View {

    /// Shows the "Set a new password" sheet for each password-reset link the window is opened with.
    func passwordResetLinks(models: any ScreenModelFactory, navigation: NavigationContext) -> some View {
        modifier(PasswordResetLinks(models: models, navigation: navigation))
    }
}
