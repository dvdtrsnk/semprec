import CoreKit
import DesignSystem
import SwiftUI

/// One bar per day or month, as tall as its cost against the dearest one; a tapped bar is marked and the others dim.
struct UsageBars: View {

    // MARK: - Dependencies
    let points: [UsagePointItem]
    let picked: Int?
    let pick: (Int) -> Void

    // MARK: - Body
    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(points.enumerated()), id: \.offset) { index, point in
                Button { pick(index) } label: {
                    Color.clear
                        .frame(maxWidth: .infinity)
                        .frame(height: Self.height)
                        .overlay(alignment: .bottom) {
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(tint(index))
                                .frame(height: max(3, Self.height * fraction(point)))
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(
                    Text(AiUsageFormat.pointLabel(point.key) + ": " + AiUsageFormat.usd(point.costUsd))
                )
                .accessibilityIdentifier(AccountIdentifiers.usageBarPrefix + String(index))
            }
        }
        .frame(height: Self.height)
    }
}

// MARK: - Private
private extension UsageBars {

    static let height: CGFloat = 96

    var highest: Double {
        points.map(\.costUsd).max() ?? 0
    }

    func fraction(_ point: UsagePointItem) -> Double {
        highest > 0 ? point.costUsd / highest : 0
    }

    func tint(_ index: Int) -> Color {
        guard let picked else { return Theme.Colors.brand }
        return index == picked ? Theme.Colors.accent : Theme.Colors.brand.opacity(0.25)
    }
}
