import Foundation

/// Creates one new screen model per call. The caller (a screen's ViewModel) owns the result; releasing
/// it closes the shared ViewModel behind it.
@MainActor
public protocol ScreenModelFactory: AnyObject, Sendable {

    func makeHome() -> any HomeScreenModel
    func makeDetail(itemId: String) -> any DetailScreenModel
    func makeSettings() -> any SettingsScreenModel
    func makeSession() -> any SessionScreenModel
    func makeLogin() -> any LoginScreenModel
    /// The sleep sheet for the evening `night` (`YYYY-MM-DD`, or nil); `startOnNight` opens it on that night.
    func makeSleep(night: String?, startOnNight: Bool) -> any SleepScreenModel
}
