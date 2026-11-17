import SwiftUI

/// The round box in front of a task: empty while the task is open, filled with a check when it is done.
struct CalendarTaskCheckbox: View {

    // MARK: - Dependencies
    let done: Bool
    let tint: Color
    let size: CGFloat
    let enabled: Bool
    let label: String
    let action: () -> Void

    // MARK: - Body
    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().strokeBorder(tint, lineWidth: 1.5).background(Circle().fill(done ? tint : .clear))
                if done {
                    Image(systemName: "checkmark")
                        .font(.system(size: size * 0.55, weight: .heavy))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: size, height: size)
            .padding(6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .padding(-6)
        .accessibilityLabel(label)
        .accessibilityAddTraits(done ? .isSelected : [])
    }
}
