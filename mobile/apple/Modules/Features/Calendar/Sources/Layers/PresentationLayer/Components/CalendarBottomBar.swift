import CoreKit
import SwiftUI

/// The two floating capsules at the bottom of the calendar, as the system Calendar's: "Dnes" at the leading edge in
/// the type of a toolbar button (body, regular), and at the trailing edge the calendars and the invitations with the
/// count of the new ones, both capsules 48 points tall. What the clipboard holds shows above them.
struct CalendarBottomBar: View {

    // MARK: - Dependencies
    let pendingInvitations: Int
    let clipboard: CalendarClipboard?
    let onToday: () -> Void
    let onCalendars: () -> Void
    let onInvitations: () -> Void

    // MARK: - Body
    var body: some View {
        VStack(spacing: 8) {
            if let clipboard {
                Text(clipboardText(clipboard))
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .glassEffect(.regular, in: .capsule)
                    .accessibilityIdentifier(CalendarIdentifiers.clipboard)
            }
            HStack {
                Button(action: onToday) {
                    Text("calendar.today", bundle: .module)
                        .font(.body)
                        .padding(.horizontal, Self.todayPadding)
                        .frame(height: Self.height)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .capsule)
                .accessibilityIdentifier(CalendarIdentifiers.today)
                Spacer()
                HStack(spacing: 0) {
                    Button(action: onCalendars) {
                        Image(systemName: "calendar")
                            .font(Self.iconFont)
                            .frame(width: Self.iconWidth, height: Self.height)
                    }
                    .accessibilityLabel(Text("calendar.calendars", bundle: .module))
                    .accessibilityIdentifier(CalendarIdentifiers.calendars)
                    Button(action: onInvitations) {
                        Image(systemName: "tray")
                            .font(Self.iconFont)
                            .frame(width: Self.iconWidth, height: Self.height)
                            .overlay(alignment: .topTrailing) { badge }
                    }
                    .accessibilityLabel(invitationsLabel)
                    .accessibilityIdentifier(CalendarIdentifiers.invitations)
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: .capsule)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }
}

// MARK: - Subviews
private extension CalendarBottomBar {

    /// The height of both capsules, the room on each side of "Dnes" and the width of each icon, as the system
    /// Calendar's bottom bar.
    static let height: CGFloat = 48
    static let todayPadding: CGFloat = 17
    static let iconWidth: CGFloat = 54
    /// The icons at the size of the system Calendar's bar.
    static let iconFont = Font.title2

    @ViewBuilder var badge: some View {
        if pendingInvitations > 0 {
            Text("\(pendingInvitations)")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .frame(minWidth: 18, minHeight: 18)
                .background(Capsule().fill(Color.red))
                .offset(x: 2, y: 2)
                .accessibilityIdentifier(CalendarIdentifiers.invitationsBadge)
        }
    }

    var invitationsLabel: Text {
        guard pendingInvitations > 0 else { return Text("calendar.invitations", bundle: .module) }
        return Text(String(format: String(localized: "calendar.invitations.new", bundle: .module), pendingInvitations))
    }

    func clipboardText(_ clipboard: CalendarClipboard) -> String {
        let key = clipboard.mode == .cut ? "calendar.clipboard.cut" : "calendar.clipboard.copied"
        return String(format: String(localized: String.LocalizationValue(key), bundle: .module), clipboard.title)
    }
}
