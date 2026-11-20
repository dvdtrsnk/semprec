import DesignSystem
import SwiftUI

/// A full page names itself to the navigation, so the back button of a subpage shows the parent's name; the page
/// shows its title large in its content, so the bar shows none.
struct NotePageTitle: ViewModifier {

    /// `nil` for a note inside another screen, which leaves the navigation alone.
    let title: String?

    func body(content: Content) -> some View {
        if let title {
            content
                .navigationTitle(Text(verbatim: title))
                .inlineNavigationTitle()
                .toolbar { ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1) } }
        } else {
            content
        }
    }
}
