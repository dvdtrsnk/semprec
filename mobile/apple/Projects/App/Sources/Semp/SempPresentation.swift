import CoreKit
import DesignSystem
import SempFeature
import SwiftUI

extension View {

    /// Shows the Semp bubble over this view, which is the content of a scene, and presents the chat over it, zooming
    /// out of the bubble and back into it. On iOS the bubble and the chat are in a window of their own over every
    /// presentation of the scene, docked in Semp's button of the tab bar while that button is shown and on top
    /// (`SempDock`); on macOS, which has no tab bar, the bubble floats over the scene's content.
    func sempOverlay(_ composition: AppComposition) -> some View {
        #if os(iOS)
        modifier(SempLayerModifier(composition: composition))
        #else
        modifier(SempOverlayModifier(composition: composition, presenter: composition.sempChat))
        #endif
    }

    /// On macOS, floats a bubble of its own over this view, the content of a sheet, because a sheet covers the bubble
    /// of the scene. What the bubble is given is the same: they share the Kotlin session of the scene. On iOS the
    /// bubble of the scene floats over its sheets already.
    func sempSheetBubble(_ composition: AppComposition, enabled: Bool) -> some View {
        #if os(iOS)
        self
        #else
        modifier(SempSheetBubbleModifier(composition: composition, presenter: composition.sempChat, enabled: enabled))
        #endif
    }
}

#if os(iOS)
/// The scene's side of its Semp layer: the objects of every presentation register in the scene's registry, a panel's
/// wish for the floating controls to step aside reaches the layer, the probe reads the tab bar and the layer's window
/// opens. While the wake guard covers the window, the layer hides and the chat closes: they are above the guard.
private struct SempLayerModifier: ViewModifier {

    // MARK: - Dependencies
    let composition: AppComposition
    @Environment(\.isWindowGuarded)
    private var isWindowGuarded

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .environment(\.dropTargets, composition.dropTargets)
            .onPreferenceChange(FloatingControlsHiddenKey.self) { [dock = composition.sempDock] hidden in
                MainActor.assumeIsolated { dock.stepsAside = hidden }
            }
            .onChange(of: isWindowGuarded, initial: true) { _, guarded in
                composition.sempDock.isGuarded = guarded
                if guarded { composition.sempChat.dismiss() }
            }
            .background {
                SempDockProbe(dock: composition.sempDock, dropTargets: composition.dropTargets)
                SempLayerWindowHost(composition: composition)
            }
    }
}
#else
/// The bubble and the chat of a scene on macOS.
private struct SempOverlayModifier: ViewModifier {

    // MARK: - Dependencies
    let composition: AppComposition
    @ObservedObject var presenter: SempChatPresenter
    /// Set while a panel at the bottom of the scene asks the bubble to step aside.
    @State private var bubbleHidden = false

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .environment(\.dropTargets, composition.dropTargets)
            .onPreferenceChange(FloatingControlsHiddenKey.self) { hidden in
                MainActor.assumeIsolated { bubbleHidden = hidden }
            }
            .overlay {
                SempScreenFactory.bubble(
                    makeModel: { composition.models.makeSempBubble() },
                    router: composition.sempRouter,
                    registry: composition.dropTargets,
                    open: { presenter.present(.latest) }
                )
                .stepsAside(bubbleHidden)
            }
            .fullScreenCoverOrSheet(isPresented: $presenter.isPresented) {
                SempChatHost(presenter: presenter, composition: composition)
            }
    }
}

/// The bubble over a sheet, with the registry of what is on that sheet. A sheet cannot present the chat of the scene
/// from below it, so it presents the chat itself: of the two presentations bound to the same state, the one of the
/// view that is on top is the one that is shown.
private struct SempSheetBubbleModifier: ViewModifier {

    // MARK: - Dependencies
    let composition: AppComposition
    @ObservedObject var presenter: SempChatPresenter
    let enabled: Bool
    @State private var registry = DropTargetRegistry()
    @State private var bubbleHidden = false

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .environment(\.dropTargets, enabled ? registry : nil)
            .onPreferenceChange(FloatingControlsHiddenKey.self) { hidden in
                MainActor.assumeIsolated { bubbleHidden = hidden }
            }
            .overlay {
                if enabled {
                    SempScreenFactory.bubble(
                        makeModel: { composition.models.makeSempBubble() },
                        router: composition.sempRouter,
                        registry: registry,
                        open: { presenter.present(.latest) }
                    )
                    .stepsAside(bubbleHidden)
                }
            }
            .fullScreenCoverOrSheet(isPresented: sheetChat) {
                SempChatHost(presenter: presenter, composition: composition)
            }
    }

    /// The chat presented from the sheet; a destination that is no sheet leaves it to the scene.
    private var sheetChat: Binding<Bool> {
        Binding(get: { enabled && presenter.isPresented }, set: { presenter.isPresented = $0 })
    }
}

// MARK: - Stepping aside
private extension View {

    /// The bubble faded out and not touchable while a panel takes the bottom of the scene, where it would cover it.
    func stepsAside(_ hidden: Bool) -> some View {
        opacity(hidden ? 0 : 1)
            .allowsHitTesting(!hidden)
            .animation(.snappy(duration: 0.2), value: hidden)
    }
}
#endif
