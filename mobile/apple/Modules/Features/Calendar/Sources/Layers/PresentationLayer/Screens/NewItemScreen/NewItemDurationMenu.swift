import DesignSystem
import SwiftUI

/// A menu of minutes, as the system Calendar offers an alert or a travel time: none, the presets and a custom value,
/// which a small sheet asks for in days, hours and minutes. The chosen value shows at the trailing edge with the
/// menu's up-and-down chevron.
struct NewItemDurationMenu: View {

    // MARK: - Dependencies
    @Binding var minutes: Int?
    let presets: [Int]
    let range: ClosedRange<Int>
    let name: (Int?) -> String
    /// The title of the sheet that asks for a custom value.
    let customTitle: LocalizedStringKey
    let identifier: String

    // MARK: - State
    @State private var isCustomizing = false

    // MARK: - Body
    var body: some View {
        Menu {
            choice(nil)
            Divider()
            ForEach(presets, id: \.self) { choice($0) }
            Divider()
            Button { isCustomizing = true } label: {
                Text("newItem.custom", tableName: "Sheets", bundle: .module)
            }
        } label: {
            HStack(spacing: 4) {
                Text(name(minutes))
                Image(systemName: "chevron.up.chevron.down").font(.footnote.weight(.semibold))
            }
            .foregroundStyle(.secondary)
        }
        .tint(.secondary)
        .accessibilityIdentifier(identifier)
        .sheet(isPresented: $isCustomizing) {
            NewItemDurationSheet(title: customTitle, minutes: minutes ?? range.lowerBound, range: range) { chosen in
                minutes = chosen
            }
            .presentationDetents([.height(380)])
        }
    }
}

// MARK: - Subviews
private extension NewItemDurationMenu {

    func choice(_ value: Int?) -> some View {
        Button { minutes = value } label: {
            if minutes == value {
                Label(name(value), systemImage: "checkmark")
            } else {
                Text(name(value))
            }
        }
    }
}

/// Asks for a number of minutes on wheels side by side, as the system timer does: days (when the range reaches past a
/// day), hours and minutes, each with its unit beside it. A value outside `range` cannot be confirmed.
struct NewItemDurationSheet: View {

    // MARK: - Dependencies
    let title: LocalizedStringKey
    let range: ClosedRange<Int>
    let onDone: (Int) -> Void
    @Environment(\.dismiss)
    private var dismiss

    // MARK: - State
    @State private var days: Int
    @State private var hours: Int
    @State private var minutes: Int

    // MARK: - Init
    init(title: LocalizedStringKey, minutes: Int, range: ClosedRange<Int>, onDone: @escaping (Int) -> Void) {
        self.title = title
        self.range = range
        self.onDone = onDone
        _days = State(initialValue: minutes / Self.dayMinutes)
        _hours = State(initialValue: minutes % Self.dayMinutes / 60)
        _minutes = State(initialValue: minutes % 60)
    }

    // MARK: - Body
    var body: some View {
        NavigationStack {
            VStack(spacing: Theme.Spacing.small) {
                HStack(spacing: Theme.Spacing.small) {
                    if range.upperBound > Self.dayMinutes {
                        wheel($days, values: 0...(range.upperBound / Self.dayMinutes), unit: "newItem.custom.days")
                    }
                    wheel($hours, values: 0...23, unit: "newItem.custom.hours")
                    wheel($minutes, values: 0...59, unit: "newItem.custom.minutes")
                }
                .frame(maxWidth: .infinity)
                Text(NewItemOptions.duration(total))
                    .font(.subheadline)
                    .foregroundStyle(range.contains(total) ? Color.secondary : Theme.Colors.destructive)
                    .contentTransition(.numericText())
                    .animation(.default, value: total)
            }
            .frame(maxHeight: .infinity)
            .navigationTitle(Text(title, tableName: "Sheets", bundle: .module))
            .inlineNavigationTitle()
            .toolbar {
                PlainToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Label { Text("newItem.cancel", tableName: "Sheets", bundle: .module) } icon: {
                            Image(systemName: "xmark")
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        onDone(total)
                        dismiss()
                    } label: {
                        Label { Text("newItem.custom.done", tableName: "Sheets", bundle: .module) } icon: {
                            Image(systemName: "checkmark")
                        }
                    }
                    .disabled(!range.contains(total))
                }
            }
        }
    }
}

// MARK: - Private
private extension NewItemDurationSheet {

    static let dayMinutes = 1440

    var total: Int { days * Self.dayMinutes + hours * 60 + minutes }

    /// A wheel of numbers with its unit beside the selected row.
    func wheel(_ value: Binding<Int>, values: ClosedRange<Int>, unit: String.LocalizationValue) -> some View {
        HStack(spacing: 4) {
            Picker(selection: value) {
                ForEach(Array(values), id: \.self) { Text(verbatim: "\($0)").tag($0) }
            } label: {
                Text(String(localized: unit, table: "Sheets", bundle: .module))
            }
            .wheelPicker()
            .labelsHidden()
            .frame(width: 56)
            Text(String(localized: unit, table: "Sheets", bundle: .module))
                .font(.body.weight(.semibold))
                .frame(width: 52, alignment: .leading)
        }
    }
}
