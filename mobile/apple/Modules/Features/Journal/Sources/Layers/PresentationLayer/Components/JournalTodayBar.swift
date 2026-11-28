import SwiftUI

/// Today at the bottom leading edge of the diary, as the calendar's and the system Calendar's: a glass capsule 48
/// points tall floating over the page, in the type of a toolbar button (body), a little heavier.
struct JournalTodayBar: View {

    // MARK: - Dependencies
    let onToday: () -> Void

    // MARK: - Body
    var body: some View {
        HStack {
            Button(action: onToday) {
                Text("journal.today", bundle: .module)
                    .font(.body.weight(.medium))
                    .padding(.horizontal, 17)
                    .frame(height: 48)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: .capsule)
            .accessibilityIdentifier(JournalIdentifiers.today)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }
}
