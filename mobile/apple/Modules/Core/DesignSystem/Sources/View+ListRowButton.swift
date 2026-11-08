import SwiftUI

// MARK: - List row button
extension View {

    /// Styles the buttons in this view as the action of a whole list row. On iOS a button in a `List` already is one:
    /// the whole row reacts and highlights when tapped, so the system style stays. On macOS a list keeps the bordered
    /// push button style, and only the button's capsule reacts to a click, so the row gets a plain label across its
    /// full width, all of which reacts to a click, and dims while pressed. Either way the button stays a button for
    /// accessibility.
    public func listRowButton() -> some View {
        #if os(macOS)
            buttonStyle(ListRowButtonStyle())
        #else
            self
        #endif
    }
}

#if os(macOS)
    /// A list row's button on macOS: its label, leading-aligned across the row, every point of which reacts.
    private struct ListRowButtonStyle: ButtonStyle {

        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .opacity(configuration.isPressed ? Theme.Opacity.pressed : 1)
        }
    }
#endif
