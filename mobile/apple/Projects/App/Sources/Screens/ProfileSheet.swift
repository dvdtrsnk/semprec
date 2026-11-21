import AccountFeature
import CoreKit
import SwiftUI

/// The sheet of the profile and settings: the profile, and the account screens it leads to on a stack of the sheet's
/// own. The profile button of the Overview opens it on the profile; the Mail screens open it on the internet accounts.
struct ProfileSheet: View {

    // MARK: - Dependencies
    private let models: any ScreenModelFactory
    private let navigation: NavigationContext
    private let notifications: AppNotifications?

    // MARK: - State
    @StateObject private var path: AccountPath
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    /// `opening` are the pages the sheet shows over the profile when it opens.
    init(
        opening: [ProfileSheetPage] = [],
        models: any ScreenModelFactory,
        navigation: NavigationContext,
        notifications: AppNotifications?
    ) {
        _path = StateObject(wrappedValue: AccountPath(pages: opening))
        self.models = models
        self.navigation = navigation
        self.notifications = notifications
    }

    // MARK: - Body
    var body: some View {
        let router = AppAccountRouter(
            path: path,
            context: navigation,
            dismissSheet: { dismiss() },
            requestPermission: { [notifications] in Task { await notifications?.requestPermission() } }
        )
        NavigationStack(path: $path.pages) {
            AccountScreenFactory.profile(makeModel: { [models] in models.makeProfile() }, router: router)
                .navigationDestination(for: ProfileSheetPage.self) { [models] page in
                    Self.destination(page, models, router: router)
                }
        }
    }
}

// MARK: - Subviews
extension ProfileSheet {

    @ViewBuilder
    static func destination(
        _ page: ProfileSheetPage,
        _ models: any ScreenModelFactory,
        router: AppAccountRouter
    ) -> some View {
        switch page {
        case .page(let page):
            Self.page(page, models, router: router)
        case .internetAccount(let accountId):
            AccountScreenFactory.internetAccount(
                makeModel: { models.makeInternetAccount(accountId: accountId) },
                router: router
            )
        }
    }

    @ViewBuilder
    static func page(_ page: AccountPage, _ models: any ScreenModelFactory, router: AppAccountRouter) -> some View {
        switch page {
        case .devices:
            AccountScreenFactory.devices { models.makeDevices() }
        case .notifications:
            AccountScreenFactory.notificationSettings(makeModel: { models.makeNotificationSettings() }, router: router)
        case .aiUsage:
            AccountScreenFactory.aiUsage { models.makeAiUsage() }
        case .trash:
            AccountScreenFactory.trash { models.makeTrash() }
        case .appearance:
            AccountScreenFactory.appearance()
        case .internetAccounts:
            AccountScreenFactory.internetAccounts(makeModel: { models.makeInternetAccounts() }, router: router)
        case .sempStatus:
            // The router closes the sheet and opens it on the Overview stack; it is never pushed here.
            EmptyView()
        }
    }
}
