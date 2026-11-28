import AccountFeature
import CoreKit

/// Routes of the Account feature, inside the profile sheet. Its pages, the internet accounts and each account among
/// them, are pushed onto the sheet's own stack; the Semp status lives on a stack of the Overview tab, so its row closes
/// the sheet and opens it there.
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
        if page == .sempStatus {
            dismissSheet()
            context.push(.sempStatus, in: .overview)
            return
        }
        push(.page(page))
    }

    func showInternetAccount(accountId: String) {
        push(.internetAccount(accountId: accountId))
    }

    func requestNotificationPermission() {
        requestPermission()
    }
}

// MARK: - Debug
// The debug menu is the app's own page of the sheet, not a route of the Account feature, which does not know it.
extension AppAccountRouter {

    func showDebugMenu() {
        push(.debug)
    }

    func showDebugAlarms() {
        push(.debugAlarms)
    }
}

// MARK: - Private
private extension AppAccountRouter {

    func push(_ page: ProfileSheetPage) {
        guard path.pages.last != page else { return }
        path.pages.append(page)
    }
}
