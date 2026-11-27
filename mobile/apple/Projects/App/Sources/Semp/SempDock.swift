import Combine
import CoreGraphics

/// Where Semp's bubble is in a scene.
enum SempDockState: Equatable {

    /// In Semp's button in the tab bar, whose frame (in global coordinates) it takes.
    case docked(CGRect)
    /// Floating over whatever is shown, because the tab bar is hidden or covered.
    case floating
    /// Gone, because an alert asks for an answer first.
    case hidden

    /// The frame of the button the bubble is docked in, nil unless docked.
    var dock: CGRect? {
        if case .docked(let frame) = self { return frame }
        return nil
    }
}

/// What the scene's window shows at the bottom, read on iOS from the tab bar the system draws.
struct SempDockReading: Equatable {

    /// The frame of Semp's button in the tab bar, in global coordinates; nil when the tab bar is not in the window or
    /// shows no such button.
    var slot: CGRect?
    /// Whether a touch at the middle of `slot` would reach the tab bar, which is false while the tab bar is hidden or
    /// anything is shown over it: a sheet, a cover, a popover, a panel.
    var slotOnTop: Bool
    /// Whether an alert is shown.
    var alertShown: Bool

    /// The window shows no tab bar at all.
    static let noTabBar = SempDockReading(slot: nil, slotOnTop: false, alertShown: false)
}

/// The state of Semp's bubble in one scene: docked in the tab bar wherever the person can see and reach Semp's button
/// there, floating everywhere else, whatever covered or hid the tab bar.
@MainActor
final class SempDock: ObservableObject {

    // MARK: - Published Properties
    @Published private(set) var state = SempDockState.floating
    /// Set while a panel at the bottom of the scene asks the floating controls to step aside.
    @Published var stepsAside = false
    /// Set while the wake guard covers the scene's window, where nothing else may be touched.
    @Published var isGuarded = false

    // MARK: - Methods
    /// Takes what the window shows now.
    func read(_ reading: SempDockReading) {
        let next = Self.state(for: reading)
        if next != state { state = next }
    }

    /// The bubble's place for what the window shows.
    nonisolated static func state(for reading: SempDockReading) -> SempDockState {
        if reading.alertShown { return .hidden }
        guard let slot = reading.slot, reading.slotOnTop else { return .floating }
        return .docked(slot)
    }
}
