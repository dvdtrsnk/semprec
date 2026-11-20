import DesignSystem
import SwiftUI

// MARK: - Styling
extension View {

    /// A card on the diary's page: near white, softly rounded and lifted a little off the gradient.
    func journalCard() -> some View {
        background(JournalColors.card, in: .rect(cornerRadius: Theme.Radius.card))
            .shadow(color: .black.opacity(0.05), radius: 14, y: 4)
    }

    /// A button on liquid glass tinted in the app's accent, with white text, as the design's Today button.
    func journalAccentGlass() -> some View {
        buttonStyle(.plain)
            .foregroundStyle(.white)
            .glassEffect(.regular.tint(Theme.Colors.appAccent.opacity(0.85)).interactive(), in: .capsule)
            .shadow(color: Theme.Colors.appAccent.opacity(0.3), radius: 10, y: 5)
    }

    /// The diary draws its own heading, so it hides the navigation bar on iOS while `hidden`; the Mac keeps its window
    /// toolbar.
    @ViewBuilder
    func journalNavigationBar(hidden: Bool) -> some View {
        #if os(iOS)
            toolbar(hidden ? .hidden : .automatic, for: .navigationBar)
        #else
            self
        #endif
    }
}
