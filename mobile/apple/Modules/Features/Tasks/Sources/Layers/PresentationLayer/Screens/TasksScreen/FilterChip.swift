import DesignSystem
import SwiftUI

/// One filter of the Tasks list as a capsule with a color dot and a button that removes it.
struct FilterChip: View {

    // MARK: - Dependencies
    let title: String
    let color: String?
    let clearLabel: String
    let clear: () -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small / 2) {
            Circle().fill(Color(hex: color) ?? Theme.Colors.accent).frame(width: 8, height: 8)
            Text(title).font(.footnote)
            Button(action: clear) {
                Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.Colors.secondaryText)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(removeLabel)
        }
        .padding(.horizontal, Theme.Spacing.small)
        .padding(.vertical, 6)
        .background(.regularMaterial, in: Capsule())
    }
}

// MARK: - Private
private extension FilterChip {

    var removeLabel: String {
        String(format: String(localized: "tasks.chip.remove", bundle: .module), locale: .current, clearLabel)
    }
}
