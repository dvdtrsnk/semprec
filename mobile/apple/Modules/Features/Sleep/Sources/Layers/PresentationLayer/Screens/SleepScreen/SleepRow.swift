import DesignSystem
import SwiftUI

/// A row of the sleep sheet: a colored symbol tile, a title and an optional line under it.
struct SleepRow: View {

    // MARK: - Dependencies
    let symbol: String
    let tint: Color
    let title: Text
    var subtitle: Text?

    // MARK: - Body
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                title
                    .foregroundStyle(Color.primary)
                if let subtitle {
                    subtitle
                        .font(.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
        } icon: {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(tint, in: RoundedRectangle(cornerRadius: 7))
        }
    }
}

// MARK: - Navigation row
/// A row that opens another view of the sheet: its content, then a chevron.
struct SleepNavigationRow: View {

    // MARK: - Dependencies
    let row: SleepRow

    // MARK: - Body
    var body: some View {
        HStack {
            row
            Spacer()
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Bindings
enum SleepBindings {

    /// A binding that shows `value` and reports a change instead of storing it, so the switch always shows the
    /// shared state.
    static func isOn(_ value: Bool, onChange: @escaping (Bool) -> Void) -> Binding<Bool> {
        Binding(get: { value }, set: onChange)
    }
}
