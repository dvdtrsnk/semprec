import Combine
import CoreKit
import Dependencies
import Foundation

/// Everything one app scene shares: the screen model factory over one Kotlin SDK, the navigation of its tabs and
/// the routers that features use. A scene owns exactly one composition. The scene's root navigator stays out of it:
/// `AppScene` holds it, so that the closures NavigatorUI keeps in the root navigation state never lead back to what
/// holds that state (see `AppScene.body`).
@MainActor
final class AppComposition: ObservableObject {

    // MARK: - Dependencies
    let models: any ScreenModelFactory
    let navigation: NavigationContext
    let homeRouter: AppHomeRouter
    let settingsRouter: AppSettingsRouter

    // MARK: - Properties
    let version: String
    let build: String

    // MARK: - Init
    init() {
        let container = SceneContainer()
        let navigation = NavigationContext()
        models = container.screenModelFactory()()
        self.navigation = navigation
        homeRouter = AppHomeRouter(context: navigation)
        settingsRouter = AppSettingsRouter(context: navigation)
        version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
    }
}
