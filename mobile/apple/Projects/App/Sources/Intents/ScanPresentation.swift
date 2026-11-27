import SwiftUI

/// Shows the document scanner full screen over a scene while `presenter` asks for a scan and this scene claimed it,
/// which it does while it is active; on macOS, which has no scanner, it shows nothing.
struct ScanPresentation: ViewModifier {

    // MARK: - Dependencies
    @ObservedObject var presenter: ScanPresenter

    #if os(iOS)
    @State private var scene = UUID()
    @Environment(\.scenePhase)
    private var scenePhase
    #endif

    // MARK: - Body
    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .fullScreenCover(isPresented: showsScanner) {
                DocumentScanner(presenter: presenter)
                    .ignoresSafeArea()
            }
            .onChange(of: presenter.request, initial: true) { claimWhenActive() }
            .onChange(of: scenePhase, initial: true) { claimWhenActive() }
        #else
        content
        #endif
    }
}

// MARK: - Subviews
#if os(iOS)
private extension ScanPresentation {

    var showsScanner: Binding<Bool> {
        let presenter = presenter
        let scene = scene
        return Binding(
            get: { presenter.scene == scene },
            // The system dismissed the cover without the scanner reporting an outcome: nothing is captured.
            set: { shown in if !shown, presenter.scene == scene { presenter.cancel() } }
        )
    }

    func claimWhenActive() {
        guard scenePhase == .active else { return }
        presenter.claim(scene: scene)
    }
}
#endif
