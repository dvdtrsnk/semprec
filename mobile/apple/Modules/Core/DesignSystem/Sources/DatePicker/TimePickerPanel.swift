import SwiftUI

/// The time wheels of the app's date picker: hours, and minutes in steps of five (plus the current minute when it is
/// not one of them), each change reaching the host at once, as on iOS. Values are `HH:mm` texts. Present it in
/// `glassPopover`.
public struct TimePickerPanel: View {

    // MARK: - Dependencies
    private let value: String
    private let onPick: (String) -> Void
    private let onDone: () -> Void

    // MARK: - Init
    /// `value` is the time shown selected; a text that is no time shows 09:00.
    public init(value: String, onPick: @escaping (String) -> Void, onDone: @escaping () -> Void) {
        self.value = value
        self.onPick = onPick
        self.onDone = onDone
    }

    // MARK: - Body
    public var body: some View {
        let time = TimeOfDay(value) ?? TimeOfDay(hour: 9, minute: 0)
        VStack(spacing: Theme.Spacing.small) {
            HStack(spacing: 0) {
                TimeWheel(
                    values: TimeOfDay.hours,
                    selection: time.hour,
                    label: Text("datePicker.hours", bundle: .module)
                ) { onPick(TimeOfDay(hour: $0, minute: time.minute).text) }
                Text(verbatim: ":").font(.title2.weight(.semibold))
                TimeWheel(
                    values: time.minutes(),
                    selection: time.minute,
                    label: Text("datePicker.minutes", bundle: .module)
                ) { onPick(TimeOfDay(hour: time.hour, minute: $0).text) }
            }
            .background {
                RoundedRectangle(cornerRadius: Self.bandRadius)
                    .fill(.quaternary)
                    .frame(height: TimeWheel.rowHeight)
            }
            Button(action: onDone) { Text("datePicker.done", bundle: .module) }
                .buttonStyle(.borderless)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .padding(Theme.Spacing.medium)
        .frame(width: Self.width)
    }

    private static let width: CGFloat = 240
    private static let bandRadius: CGFloat = 10
}

/// One wheel: a column of numbers that snaps the row under the selection band.
private struct TimeWheel: View {

    // MARK: - Dependencies
    let values: [Int]
    let selection: Int
    let label: Text
    let onSelect: (Int) -> Void

    // MARK: - Properties
    @State private var position: Int?

    static let rowHeight: CGFloat = 36
    private static let visibleRows: CGFloat = 5

    // MARK: - Body
    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            LazyVStack(spacing: 0) {
                ForEach(values, id: \.self) { value in
                    Text(value, format: .number.precision(.integerLength(2...)))
                        .font(.title3)
                        .opacity(value == selection ? 1 : 0.45)
                        .frame(maxWidth: .infinity)
                        .frame(height: Self.rowHeight)
                        .contentShape(Rectangle())
                        .onTapGesture { select(value) }
                }
            }
            .scrollTargetLayout()
        }
        .scrollPosition(id: $position, anchor: .center)
        .scrollTargetBehavior(.viewAligned)
        .contentMargins(.vertical, Self.rowHeight * 2, for: .scrollContent)
        .frame(height: Self.rowHeight * Self.visibleRows)
        .onAppear { position = selection }
        .onChange(of: position) { _, new in
            if let new, new != selection { onSelect(new) }
        }
        .onChange(of: selection) { _, new in
            if position != new { position = new }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(Text(selection, format: .number.precision(.integerLength(2...))))
        .accessibilityAdjustableAction { direction in
            guard let index = values.firstIndex(of: selection) else { return }
            switch direction {
            case .increment: if index + 1 < values.count { select(values[index + 1]) }
            case .decrement: if index > 0 { select(values[index - 1]) }
            @unknown default: break
            }
        }
    }

    // MARK: - Private
    private func select(_ value: Int) {
        position = value
        if value != selection { onSelect(value) }
    }
}

// MARK: - Preview
#Preview {
    TimePickerPanel(value: "14:30", onPick: { _ in }, onDone: {})
}
