import SwiftUI

/// A small rounded square with an SF Symbol, the icon of a row, as the Settings app shows them.
struct IconTile: View {

    // MARK: - Dependencies
    let symbol: String
    let tint: Color

    // MARK: - Body
    var body: some View {
        Image(systemName: symbol)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(tint, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityHidden(true)
    }
}
