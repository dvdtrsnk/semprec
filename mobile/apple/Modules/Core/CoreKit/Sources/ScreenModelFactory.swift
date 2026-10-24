import Foundation

/// Creates one new screen model per call. The caller (a screen's ViewModel) owns the result; releasing
/// it closes the shared ViewModel behind it.
@MainActor
public protocol ScreenModelFactory: AnyObject, Sendable {

    func makeHome() -> any HomeScreenModel
    func makeDetail(itemId: String) -> any DetailScreenModel
    func makeSettings() -> any SettingsScreenModel
}
