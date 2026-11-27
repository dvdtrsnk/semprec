#if os(iOS)
import Combine
import SwiftUI

/// Opens the window of a scene's Semp layer on iOS, over every sheet, cover and popover the scene presents, for as
/// long as the scene's content exists: under a full-screen cover the content leaves its window, and the layer stays
/// to float the bubble over the cover. SwiftUI shows a view over a presentation only from inside
/// that presentation, and has no window of its own over a scene's window on iOS, so the layer lives in a `UIWindow`
/// of the same window scene that lets through every touch its `SempLayerHitRegion` does not take.
struct SempLayerWindowHost: UIViewRepresentable {

    // MARK: - Dependencies
    let composition: AppComposition

    // MARK: - UIViewRepresentable
    func makeUIView(context: Context) -> SempLayerWindowAnchor {
        SempLayerWindowAnchor(composition: composition)
    }

    func updateUIView(_ anchor: SempLayerWindowAnchor, context: Context) {}
}

/// The view behind the scene's content whose window scene the layer's window joins.
final class SempLayerWindowAnchor: UIView {

    // MARK: - Dependencies
    private let composition: AppComposition

    // MARK: - Properties
    private var layerWindow: SempLayerWindow?
    private var chatShown: AnyCancellable?

    // MARK: - Init
    init(composition: AppComposition) {
        self.composition = composition
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    // MARK: - Lifecycle
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard let sceneWindow = window, let windowScene = sceneWindow.windowScene,
              layerWindow?.windowScene !== windowScene else { return }
        open(in: windowScene, over: sceneWindow)
    }

    // MARK: - Private
    private func open(in windowScene: UIWindowScene, over sceneWindow: UIWindow) {
        close()
        let region = SempLayerHitRegion()
        let root = SempLayer(
            composition: composition,
            presenter: composition.sempChat,
            dock: composition.sempDock,
            hitRegion: region
        )
        .appAppearance()
        let host = UIHostingController(rootView: root)
        host.view.backgroundColor = .clear
        let layerWindow = SempLayerWindow(windowScene: windowScene, region: region)
        layerWindow.windowLevel = sceneWindow.windowLevel + 1
        layerWindow.rootViewController = host
        layerWindow.isHidden = false
        self.layerWindow = layerWindow
        // The chat takes the keyboard while it is open: a text field reaches it only in the key window. Closed, the
        // scene's window takes it back.
        chatShown = composition.sempChat.$isPresented
            .removeDuplicates()
            .sink { [weak layerWindow, weak sceneWindow] shown in
                if shown { layerWindow?.makeKey() } else { sceneWindow?.makeKey() }
            }
    }

    private func close() {
        chatShown = nil
        layerWindow?.isHidden = true
        layerWindow?.rootViewController = nil
        layerWindow = nil
    }
}

/// A window that takes only the touches its region takes, and lets the others through to the windows below.
final class SempLayerWindow: UIWindow {

    // MARK: - Dependencies
    private let region: SempLayerHitRegion

    // MARK: - Init
    init(windowScene: UIWindowScene, region: SempLayerHitRegion) {
        self.region = region
        super.init(windowScene: windowScene)
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    // MARK: - Hit testing
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        region.takes(point) && super.point(inside: point, with: event)
    }
}
#endif
