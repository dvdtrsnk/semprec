import CoreKit
import SwiftUI

/// Covers one window with the wake guard while a mission rings. The window's own guard model decides when that is;
/// when ringing starts, the sheets presented over the window's stacks are closed first, because a sheet would sit
/// above the guard, and the window's navigation opens nothing until the guard goes. While it covers the window the
/// content below takes no touch and is hidden from accessibility.
struct WakeGuardHost: ViewModifier {

    // MARK: - Dependencies
    @StateObject private var viewModel: WakeGuardViewModel
    private let navigation: NavigationContext

    // MARK: - Init
    /// `makeModel` runs once per window, when SwiftUI creates the state object.
    init(makeModel: @escaping @MainActor () -> any WakeGuardScreenModel, navigation: NavigationContext) {
        _viewModel = StateObject(wrappedValue: WakeGuardViewModel(model: makeModel()))
        self.navigation = navigation
    }

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .disabled(isCovering)
            .accessibilityHidden(isCovering)
            .overlay {
                if isCovering {
                    WakeGuardScreen(viewModel: viewModel)
                        .ignoresSafeArea()
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.3), value: isCovering)
            .onChange(of: isCovering, initial: true) { _, covering in
                navigation.isBlocked = covering
                if covering { navigation.dismissAllPresented() }
            }
            .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension WakeGuardHost {

    var isCovering: Bool {
        viewModel.state.phase != .idle
    }
}

// MARK: - View
extension View {

    /// Covers the view with the wake guard of its window while a wake mission rings.
    func wakeGuard(
        makeModel: @escaping @MainActor () -> any WakeGuardScreenModel,
        navigation: NavigationContext
    ) -> some View {
        modifier(WakeGuardHost(makeModel: makeModel, navigation: navigation))
    }
}
