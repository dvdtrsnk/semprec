import DesignSystem
import SwiftUI

/// A time of the ring (bedtime or wake-up) that opens a time picker in a popover. The picked time is sent once, when
/// the popover closes, so scrolling through the wheel does not write every step.
struct SleepTimeButton: View {

    // MARK: - Dependencies
    let title: Text
    let minutes: Int
    let accessibilityLabel: String
    let identifier: String
    let commit: (Int) -> Void

    // MARK: - Properties
    @State private var isPresented = false
    @State private var draft = Date()

    // MARK: - Body
    var body: some View {
        Button {
            draft = Self.date(minutes: minutes)
            isPresented = true
        } label: {
            VStack(spacing: 2) {
                title
                    .font(.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Text(SleepFormat.time(minutes))
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Color.primary)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .accessibilityLabel(Text(accessibilityLabel))
        .accessibilityIdentifier(identifier)
        .popover(isPresented: $isPresented) { picker }
        .onChange(of: isPresented) { _, presented in
            if !presented { commitDraft() }
        }
    }
}

// MARK: - Subviews
private extension SleepTimeButton {

    var picker: some View {
        DatePicker("", selection: $draft, displayedComponents: .hourAndMinute)
            .datePickerStyle(.graphical)
            .labelsHidden()
            .padding(Theme.Spacing.medium)
            .presentationCompactAdaptation(.popover)
    }
}

// MARK: - Private
private extension SleepTimeButton {

    func commitDraft() {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: draft)
        let picked = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        if picked != minutes { commit(picked) }
    }

    static func date(minutes: Int) -> Date {
        let start = Calendar.current.startOfDay(for: Date())
        return Calendar.current.date(byAdding: .minute, value: minutes, to: start) ?? start
    }
}
