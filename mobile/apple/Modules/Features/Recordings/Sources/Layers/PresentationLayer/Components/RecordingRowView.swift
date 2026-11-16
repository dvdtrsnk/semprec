import CoreKit
import DesignSystem
import SwiftUI

/// One recording of a list: its name, when and how long, and a chip that says where it is on its way to a transcript
/// and which event it belongs to.
struct RecordingRowView: View {

    // MARK: - Dependencies
    let row: RecordingRow

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(row.name)
                .font(.headline)
                .foregroundStyle(Color.primary)
                .lineLimit(1)
            Text(details)
                .font(.subheadline)
                .foregroundStyle(Theme.Colors.secondaryText)
            chip
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Subviews
private extension RecordingRowView {

    var details: String {
        [RecordingFormatting.when(row.date), row.durationSeconds.map(RecordingFormatting.clock)]
            .compactMap { $0 }
            .joined(separator: " \u{00B7} ")
    }

    var chip: some View {
        HStack(spacing: 5) {
            if row.processing { ProgressView().controlSize(.mini) }
            chipText
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .frame(height: 22)
        .foregroundStyle(chipForeground)
        .background(chipBackground, in: Capsule())
    }

    @ViewBuilder var chipText: some View {
        if row.status == .error {
            Text("recording.chip.failed", bundle: .module)
        } else if row.processing {
            Text("recording.chip.processing", bundle: .module)
        } else if row.pairing == .awaitingEvent {
            Text("recording.chip.awaitingEvent", bundle: .module)
        } else if row.pairing == .event, let name = row.eventName {
            Text(String(format: String(localized: "recording.chip.event", bundle: .module), name))
        } else {
            Text("recording.chip.noEvent", bundle: .module)
        }
    }

    var chipForeground: Color {
        if row.status == .error || row.pairing == .awaitingEvent { return Theme.Colors.destructive }
        return row.pairing == .event ? .purple : Theme.Colors.secondaryText
    }

    var chipBackground: Color {
        chipForeground.opacity(0.12)
    }
}
