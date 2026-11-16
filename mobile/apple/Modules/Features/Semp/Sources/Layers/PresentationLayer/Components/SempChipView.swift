import CoreKit
import SwiftUI

/// An object a message is about: its icon in the color of its kind, and its name.
struct SempChipView: View {

    // MARK: - Dependencies
    let kind: SempTargetKind
    let label: String?
    var exists = true
    /// Called by the remove button; nil for a chip that cannot be removed.
    var remove: (() -> Void)?

    // MARK: - Body
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: kind.symbol)
                .foregroundStyle(exists ? kind.color : .secondary)
                .imageScale(.small)
            Text(label ?? String(localized: "semp.chip.gone", bundle: .module))
                .font(.subheadline)
                .lineLimit(1)
                .foregroundStyle(exists ? .primary : .secondary)
            if let remove {
                Button(action: remove) {
                    Image(systemName: "xmark").imageScale(.small).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(removeLabel)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.quaternary, in: Capsule())
        .accessibilityElement(children: remove == nil ? .combine : .contain)
    }
}

// MARK: - Accessibility
private extension SempChipView {

    var removeLabel: String {
        String(
            format: String(localized: "semp.chip.remove", bundle: .module),
            locale: .current,
            kind.name,
            label ?? ""
        )
    }
}

#Preview {
    VStack(alignment: .leading) {
        SempChipView(kind: .task, label: "Odeslat fakturu", remove: {})
        SempChipView(kind: .mail, label: nil, exists: false)
    }
    .padding()
}
