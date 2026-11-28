import SwiftUI

/// The tabs of the app, in the order of the tab bar.
enum AppTab: Hashable {

    case overview
    case calendar
    case journal
}

/// What the tab view of a scene can select: the tab of an area, or Semp's button, which opens the chat instead of
/// a page.
enum SceneTab: Hashable {

    case area(AppTab)
    case semp
}

// MARK: - Selection
extension SceneTab {

    /// The role of Semp's button: prominent on iOS, which draws it apart at the trailing end of the tab bar. macOS
    /// shows no Semp button, and its minimum (26) has no prominent role.
    static var sempRole: TabRole? {
        #if os(iOS)
        .prominent
        #else
        nil
        #endif
    }

    /// The tab view's selection over the scene's selected tab: an area's tab selects it, and Semp's button opens the
    /// chat and leaves the selected tab as it was. The bubble docked over the button takes its touches, so this is
    /// the path of VoiceOver and of a keyboard only.
    @MainActor
    static func selection(_ selectedTab: Binding<AppTab>, chat: SempChatPresenter) -> Binding<SceneTab> {
        Binding(
            get: { .area(selectedTab.wrappedValue) },
            set: { tab in
                switch tab {
                case .area(let area): selectedTab.wrappedValue = area
                case .semp: chat.present(.latest)
                }
            }
        )
    }
}
