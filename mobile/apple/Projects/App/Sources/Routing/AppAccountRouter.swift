import AccountFeature
import CoreKit

/// Routes of the Account feature, inside the profile sheet. The e-mail accounts live on a stack of the Overview tab,
/// so their row closes the sheet and opens them there; the Semp status does the same.
@MainActor
final class AppAccountRouter {

    // MARK: - Dependencies
    private let path: AccountPath
    private let context: NavigationContext
    private let dismissSheet: @MainActor () -> Void
    private let requestPermission: @MainActor () -> Void

    // MARK: - Init
    /// `dismissSheet` closes the profile sheet, which the Overview tab presented; `requestPermission` asks for the
    /// permission to notify.
    init(
        path: AccountPath,
        context: NavigationContext,
        dismissSheet: @escaping @MainActor () -> Void,
        requestPermission: @escaping @MainActor () -> Void
    ) {
        self.path = path
        self.context = context
        self.dismissSheet = dismissSheet
        self.requestPermission = requestPermission
    }
}

// MARK: - Protocol conformance
extension AppAccountRouter: AccountRouting {

    /// Pushes `page` onto the sheet's stack, unless it already is the page on top (a second tap that arrived with the
    /// first).
    func show(_ page: AccountPage) {
        if page == .mailAccounts {
            dismissSheet()
            context.showMailAccounts(in: .overview)
            return
        }
        if page == .sempStatus {
            dismissSheet()
            context.push(.sempStatus, in: .overview)
            return
        }
        guard path.pages.last != page else { return }
        path.pages.append(page)
    }

    func requestNotificationPermission() {
        requestPermission()
    }
}
