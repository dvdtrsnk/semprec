import AccountFeature
import CoreKit
import SwiftUI

/// The sheet the profile button of the Overview opens: the profile, and the account screens it leads to on a stack of
/// the sheet's own.
struct ProfileSheet: View {

    // MARK: - Dependencies
    private let models: any ScreenModelFactory
    private let navigation: NavigationContext

    // MARK: - State
    @StateObject private var path = AccountPath()
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - Init
    init(models: any ScreenModelFactory, navigation: NavigationContext) {
        self.models = models
        self.navigation = navigation
    }

    // MARK: - Body
    var body: some View {
        NavigationStack(path: $path.pages) {
            AccountScreenFactory.profile(
                makeModel: { [models] in models.makeProfile() },
                router: AppAccountRouter(path: path, context: navigation, dismissSheet: { dismiss() })
            )
            .navigationDestination(for: AccountPage.self) { [models] page in
                Self.destination(page, models)
            }
        }
    }
}

// MARK: - Subviews
extension ProfileSheet {

    @ViewBuilder
    static func destination(_ page: AccountPage, _ models: any ScreenModelFactory) -> some View {
        switch page {
        case .devices:
            AccountScreenFactory.devices { models.makeDevices() }
        case .notifications:
            AccountScreenFactory.notificationSettings { models.makeNotificationSettings() }
        case .aiUsage:
            AccountScreenFactory.aiUsage { models.makeAiUsage() }
        case .trash:
            AccountScreenFactory.trash { models.makeTrash() }
        case .sempStatus, .mailAccounts:
            // The router closes the sheet and opens these on the Overview stack; they are never pushed here.
            EmptyView()
        }
    }
}
