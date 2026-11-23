import SwiftUI

/// The solid layer the diary's axis lies on, made as the calendar's day header is: the colours of what lies under it
/// (the haze the page starts with) blurred into one another and veiled a little. Its colours change only across, never
/// down, so the strip behind the pinned row and the layer under the axis meet without a seam wherever they are.
struct JournalHeaderMaterial: View {

    var body: some View {
        LinearGradient(colors: JournalBackgroundPattern.topColors, startPoint: .leading, endPoint: .trailing)
            .overlay(.background.opacity(0.12))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// The line that ends the axis's material, as the calendar's day header ends: half a point of the system separator.
struct JournalDivider: View {

    var body: some View {
        Rectangle()
            .fill(.separator)
            .frame(height: 0.5)
            .accessibilityHidden(true)
    }
}

// MARK: - Kept at the top
extension View {

    /// Keeps a view that ends at the top of the scroll view's content there whatever the scroll: it covers the top of
    /// the screen, above the content's inset. Worked out as each frame is drawn, so it never lags the scroll.
    func keptAtTop() -> some View {
        visualEffect { content, proxy in
            content.offset(y: max(0, -proxy.frame(in: .scrollView).maxY))
        }
    }
}
