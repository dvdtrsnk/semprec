import CoreKit
import DesignSystem
import SempFeature
import SwiftUI

extension View {

    /// Floats the Semp bubble over this view, which is the content of a scene, and presents the chat over it. The
    /// bubble is hidden while the chat is open.
    func sempOverlay(_ composition: AppComposition) -> some View {
        modifier(SempOverlayModifier(composition: composition, presenter: composition.sempChat))
    }

    /// Floats a bubble of its own over this view, the content of a sheet, because a sheet covers the bubble of the
    /// scene. What the bubble is given is the same: they share the Kotlin session of the scene.
    func sempSheetBubble(_ composition: AppComposition, enabled: Bool) -> some View {
        modifier(SempSheetBubbleModifier(composition: composition, presenter: composition.sempChat, enabled: enabled))
    }
}

/// The bubble and the chat of a scene.
private struct SempOverlayModifier: ViewModifier {

    // MARK: - Dependencies
    let composition: AppComposition
    @ObservedObject var presenter: SempChatPresenter

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .environment(\.dropTargets, composition.dropTargets)
            .overlay {
                if !presenter.isPresented {
                    SempScreenFactory.bubble(
                        makeModel: { composition.models.makeSempBubble() },
                        router: composition.sempRouter,
                        registry: composition.dropTargets,
                        open: { presenter.present(.latest) }
                    )
                }
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

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .environment(\.dropTargets, enabled ? registry : nil)
            .overlay {
                if enabled, !presenter.isPresented {
                    SempScreenFactory.bubble(
                        makeModel: { composition.models.makeSempBubble() },
                        router: composition.sempRouter,
                        registry: registry,
                        open: { presenter.present(.latest) }
                    )
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
