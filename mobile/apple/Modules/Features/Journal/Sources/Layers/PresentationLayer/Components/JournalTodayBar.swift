import SwiftUI

/// Today at the bottom leading edge of the diary, as the calendar's: a glass capsule floating over the page.
struct JournalTodayBar: View {

    // MARK: - Dependencies
    let onToday: () -> Void

    // MARK: - Body
    var body: some View {
        HStack {
            Button(action: onToday) {
                Text("journal.today", bundle: .module)
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 18)
                    .frame(height: 44)
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
