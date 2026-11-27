#if os(iOS)
import CoreGraphics
import DesignSystem
import SempFeature
import SwiftUI

/// Where the layer of the bubble takes touches: the bubble's circle while it can be touched, everything while the
/// chat is open over it, nothing else. The window that holds the layer lets every other touch through to the scene.
@MainActor
final class SempLayerHitRegion {

    // MARK: - Properties
    /// The bubble's frame in global coordinates.
    var bubble = CGRect.null
    /// Whether the bubble can be touched, which it cannot while it steps aside.
    var bubbleShown = false
    var chatShown = false

    // MARK: - Methods
    func takes(_ point: CGPoint) -> Bool {
        chatShown || (bubbleShown && bubble.contains(point))
    }
}

/// The bubble of a scene over all of its presentations on iOS, docked in Semp's button of the tab bar or floating, as
/// `dock` says, and the chat it opens, zooming out of the bubble and back into it.
struct SempLayer: View {

    // MARK: - Dependencies
    let composition: AppComposition
    @ObservedObject var presenter: SempChatPresenter
    @ObservedObject var dock: SempDock
    let hitRegion: SempLayerHitRegion

    // MARK: - Properties
    @Namespace private var zoom
    @State private var isKeyboardShown = false

    // MARK: - Body
    var body: some View {
        let away = dock.stepsAside || dock.isGuarded || isKeyboardShown || dock.state == .hidden
        SempScreenFactory.bubble(
            makeModel: { composition.models.makeSempBubble() },
            router: composition.sempRouter,
            registry: composition.dropTargets,
            dock: dock.state.dock,
            zoom: zoom,
            open: { presenter.present(.latest) },
            reportFrame: { frame in hitRegion.bubble = frame }
        )
        .opacity(away ? 0 : 1)
        .allowsHitTesting(!away)
        .animation(.snappy(duration: 0.2), value: away)
        .onChange(of: away, initial: true) { _, isAway in hitRegion.bubbleShown = !isAway }
        .onChange(of: presenter.isPresented, initial: true) { _, shown in hitRegion.chatShown = shown }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            isKeyboardShown = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            isKeyboardShown = false
        }
        .fullScreenCoverOrSheet(isPresented: $presenter.isPresented) {
            SempChatHost(presenter: presenter, composition: composition)
                .navigationTransition(.zoom(sourceID: SempScreenFactory.bubbleTransitionID, in: zoom))
        }
    }
}
#endif
