import CoreKit
import DesignSystem
import SwiftUI

/// The settings of one calendar inside the calendars sheet: its name, colour and notifications, and deleting it. The
/// typed name stays here and is sent when the field is submitted, loses focus or the page is left. An account
/// calendar is renamed and recoloured here only, can go back to the provider's colour and is not deleted.
struct CalendarDetailPage: View {

    // MARK: - Dependencies
    let calendar: CalendarRow
    let swatches: [CalendarSwatch]
    let busy: Bool
    let send: (CalendarListAction) -> Void
    @State private var name: String
    /// The last name sent, so that leaving the field and then the page sends it once.
    @State private var sentName: String?
    @FocusState private var nameFocused: Bool

    // MARK: - Init
    init(calendar: CalendarRow, swatches: [CalendarSwatch], busy: Bool, send: @escaping (CalendarListAction) -> Void) {
        self.calendar = calendar
        self.swatches = swatches
        self.busy = busy
        self.send = send
        _name = State(initialValue: calendar.name)
    }

    // MARK: - Body
    var body: some View {
        Form {
            nameSection
            colorSection
            notifySection
            if calendar.canDelete {
                Section {
                    Button(role: .destructive) { send(.requestDelete(calendarId: calendar.id)) } label: {
                        Text("calendars.detail.delete", tableName: "Sheets", bundle: .module)
                            .frame(maxWidth: .infinity)
                    }
                    .listRowButton()
                    .disabled(busy)
                    .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsDelete)
                }
            }
        }
        .formStyle(.grouped)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsDetail)
        .onChange(of: nameFocused) { _, focused in
            if !focused { commitName() }
        }
        .onDisappear(perform: commitName)
    }
}

// MARK: - Subviews
private extension CalendarDetailPage {

    @ViewBuilder var nameSection: some View {
        Section {
            if calendar.canRename {
                TextField(
                    text: $name,
                    prompt: Text("calendars.detail.namePrompt", tableName: "Sheets", bundle: .module)
                ) {
                    Text("calendars.detail.name", tableName: "Sheets", bundle: .module)
                }
                .labelsHidden()
                .focused($nameFocused)
                .submitLabel(.done)
                .onSubmit(commitName)
                .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsName)
            } else {
                Text(calendar.name)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .accessibilityLabel(Text("calendars.detail.name", tableName: "Sheets", bundle: .module))
                    .accessibilityValue(Text(calendar.name))
                    .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsName)
            }
        } footer: {
            if let providerName = calendar.providerName {
                Text(providerName)
            }
        }
    }

    var colorSection: some View {
        Section {
            if calendar.group == .account, let remoteColor = calendar.remoteColor {
                remoteColorRow(remoteColor)
            }
            ForEach(swatches) { swatch in
                let selected = !calendar.usesRemoteColor && swatch.matches(calendar.color)
                Button { send(.change(.setColor(calendarId: calendar.id, color: swatch.hex))) } label: {
                    HStack(spacing: Theme.Spacing.medium) {
                        Circle()
                            .fill(Color(hex: swatch.hex) ?? Theme.Colors.accent)
                            .frame(width: Self.dotSize, height: Self.dotSize)
                        Text(swatch.name)
                            .foregroundStyle(Color.primary)
                        Spacer(minLength: 0)
                        if selected {
                            Image(systemName: "checkmark")
                                .fontWeight(.semibold)
                                .foregroundStyle(Theme.Colors.accent)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .listRowButton()
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier(CalendarSheetIdentifiers.calendarColor(swatch.key))
            }
        } header: {
            Text("calendars.detail.color", tableName: "Sheets", bundle: .module)
        }
    }

    static let dotSize: CGFloat = 14

    /// The provider's colour, chosen while nothing was set here; choosing it clears the colour set here.
    func remoteColorRow(_ hex: String) -> some View {
        Button { send(.change(.useRemoteColor(calendarId: calendar.id))) } label: {
            HStack(spacing: Theme.Spacing.medium) {
                Circle()
                    .fill(Color(hex: hex) ?? Theme.Colors.accent)
                    .frame(width: Self.dotSize, height: Self.dotSize)
                Text("calendars.detail.remoteColor", tableName: "Sheets", bundle: .module)
                    .foregroundStyle(Color.primary)
                Spacer(minLength: 0)
                if calendar.usesRemoteColor {
                    Image(systemName: "checkmark")
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.Colors.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .listRowButton()
        .disabled(calendar.usesRemoteColor)
        .accessibilityAddTraits(calendar.usesRemoteColor ? .isSelected : [])
        .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsRemoteColor)
    }

    var notifySection: some View {
        Section {
            Toggle(isOn: notify) {
                Text("calendars.detail.notify", tableName: "Sheets", bundle: .module)
            }
            .accessibilityLabel(Text("calendars.detail.notify.a11y", tableName: "Sheets", bundle: .module))
            .accessibilityIdentifier(CalendarSheetIdentifiers.calendarsNotify)
        } footer: {
            Text(calendar.hint)
        }
    }

    var notify: Binding<Bool> {
        Binding(
            get: { calendar.notify },
            set: { send(.change(.setNotify(calendarId: calendar.id, notify: $0))) }
        )
    }

    /// Sends a changed, non-blank name; the field shows the stored name again when it was emptied.
    func commitName() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard calendar.canRename else { return }
        guard !trimmed.isEmpty else {
            name = calendar.name
            return
        }
        guard trimmed != (sentName ?? calendar.name) else { return }
        sentName = trimmed
        send(.change(.rename(calendarId: calendar.id, name: trimmed)))
    }
}

// MARK: - Preview
#Preview("Own") {
    NavigationStack {
        CalendarDetailPage(
            calendar: CalendarRow(id: "work", name: "Práce", color: "#007AFF"),
            swatches: CalendarListState.previewSwatches,
            busy: false,
            send: { _ in }
        )
    }
}

#Preview("Account") {
    NavigationStack {
        CalendarDetailPage(
            calendar: CalendarRow(
                id: "family", name: "Rodina", color: "#16A765", group: .account, canDelete: false, accountId: "m1",
                remoteName: "Family", remoteColor: "#16A765", usesRemoteColor: true
            ),
            swatches: CalendarListState.previewSwatches,
            busy: false,
            send: { _ in }
        )
    }
}

#Preview("Subscription") {
    NavigationStack {
        CalendarDetailPage(
            calendar: CalendarRow(
                id: "holidays", name: "Státní svátky", color: "#34C759", group: .subscription,
                systemKey: "holidaysCz", canRename: false, canDelete: false
            ),
            swatches: CalendarListState.previewSwatches,
            busy: false,
            send: { _ in }
        )
    }
}
