import CoreKit

/// The task or event whose Podrobnosti sheet is shown. Two targets are the same sheet when they name the same item:
/// the tab only says where an event page that the sheet opens goes.
struct ItemDetailsTarget: Hashable {

    let kind: ItemKind
    let id: String
    /// The tab whose stack the sheet was presented over; an event page the sheet opens goes onto it.
    var tab: AppTab?
}

// MARK: - Identity
extension ItemDetailsTarget {

    static func == (lhs: ItemDetailsTarget, rhs: ItemDetailsTarget) -> Bool {
        lhs.kind == rhs.kind && lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(kind)
        hasher.combine(id)
    }
}
