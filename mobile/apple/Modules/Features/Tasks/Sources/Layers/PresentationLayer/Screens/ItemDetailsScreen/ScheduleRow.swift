import DesignSystem
import SwiftUI

/// A row of the Podrobnosti sheet with a colored icon tile, a title, a line under it in the color of an editable
/// value and, optionally, a switch. Tapping the row calls `action`.
struct ScheduleRow: View {

    // MARK: - Dependencies
    let symbol: String
    let tint: Color
    let title: LocalizedStringKey
    var subtitle: String?
    var subtitleStyle: Color = Theme.Colors.accent
    var isOn: Binding<Bool>?
    var showsChevron = false
    var identifier: String?
    let action: () -> Void

    // MARK: - Body
    var body: some View {
        HStack(spacing: Theme.Spacing.small) {
            Button(action: action) {
                HStack(spacing: Theme.Spacing.small) {
                    IconTile(symbol: symbol, tint: tint)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title, bundle: .module).foregroundStyle(Color.primary)
                        if let subtitle {
                            Text(subtitle).font(.subheadline).foregroundStyle(subtitleStyle)
                        }
                    }
                    Spacer(minLength: 0)
                    if showsChevron {
                        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let isOn {
                Toggle(isOn: isOn) { Text(title, bundle: .module) }.labelsHidden()
            }
        }
        .accessibilityIdentifier(identifier ?? "")
    }
}

/// A small rounded square with an SF Symbol, the icon of a row.
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
