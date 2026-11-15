import CoreKit
import Foundation
import SwiftUI

/// What deleting an item reaches, worded for the confirmation: the item goes to the trash for 30 days, and every
/// collection, nested item, page and taken-over value the deletion touches is named with its number.
struct DeletionSummary {

    // MARK: - Dependencies
    let title: String
    let impact: ImpactView
    /// The names of the databases the item is connected to, by their canonical key.
    let names: [String: String]

    // MARK: - Methods
    var message: String {
        var lines = [String(format: String(localized: "delete.intro", bundle: .module), title)]
        lines += impact.related.map { "\(names[$0.databaseKey ?? ""] ?? $0.databaseKey ?? ""): \($0.count)" }
        lines += counted("delete.nestedItems", impact.nestedItems)
        lines += counted("delete.nestedPages", impact.nestedPages)
        lines += counted("delete.takenOver", impact.takenOverValues)
        lines += counted("delete.series", impact.seriesInstances)
        lines += counted("delete.attachments", impact.attachments)
        lines += counted("delete.hostEvents", impact.hostEvents)
        return lines.joined(separator: "\n")
    }

    private func counted(_ key: String, _ count: Int) -> [String] {
        guard count > 0 else { return [] }
        let format = Bundle.module.localizedString(forKey: key, value: nil, table: nil)
        return [String(format: format, count)]
    }
}

/// The confirmation of a deletion. It appears once the impact is read; a failed read or deletion is shown instead.
struct DeletionAlert: ViewModifier {

    // MARK: - Dependencies
    let deletion: DeletionView?
    let title: String
    let names: [String: String]
    let send: (ItemAction) -> Void

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .overlay { if deletion?.loading == true || deletion?.deleting == true { ProgressView() } }
            .alert(
                Text("delete.title", bundle: .module),
                isPresented: Binding(
                    get: { isShown },
                    set: { if !$0 { send(.deletion(.cancel)) } }
                ),
                presenting: deletion
            ) { deletion in
                if deletion.failure == nil, deletion.impact != nil {
                    Button(role: .destructive) {
                        send(.deletion(.confirm))
                    } label: {
                        Text("delete.confirm", bundle: .module)
                    }
                }
                Button(role: .cancel) { send(.deletion(.cancel)) } label: { Text("delete.cancel", bundle: .module) }
            } message: { deletion in
                if let failure = deletion.failure {
                    Text(FailureKind.message(for: failure.kind))
                } else if let impact = deletion.impact {
                    Text(DeletionSummary(title: title, impact: impact, names: names).message)
                }
            }
    }

    private var isShown: Bool {
        guard let deletion else { return false }
        return !deletion.loading && !deletion.deleting && (deletion.impact != nil || deletion.failure != nil)
    }
}

// MARK: - View
extension View {

    func deletionAlert(
        _ deletion: DeletionView?,
        title: String,
        names: [String: String],
        send: @escaping (ItemAction) -> Void
    ) -> some View {
        modifier(DeletionAlert(deletion: deletion, title: title, names: names, send: send))
    }
}
