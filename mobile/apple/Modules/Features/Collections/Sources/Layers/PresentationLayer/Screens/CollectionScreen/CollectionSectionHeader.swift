import CoreKit
import DesignSystem
import SwiftUI

/// The heading of a group of rows: a status with its color, a day or month, a letter, or the server's own wording
/// for items before today and items without a value.
struct CollectionSectionHeader: View {

    // MARK: - Dependencies
    let section: CollectionSection
    let format: FieldFormat

    // MARK: - Body
    var body: some View {
        HStack(spacing: 6) {
            if let tint = Color(hex: section.color) {
                Circle().fill(tint).frame(width: 8, height: 8)
            }
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(titleColor)
        }
        .textCase(nil)
    }
}

// MARK: - Subviews
private extension CollectionSectionHeader {

    var title: String {
        switch section.kind {
        case .none: ""
        case .option, .past: section.label
        case .noValue: section.label.isEmpty ? String(localized: "section.noValue", bundle: .module) : section.label
        case .day: format.day(section.key)
        case .month: format.month(section.key)
        case .letter: section.key
        }
    }

    var titleColor: Color {
        let isToday = section.kind == .day && format.isToday(section.key)
        return isToday ? Theme.Colors.destructive : .primary
    }
}
