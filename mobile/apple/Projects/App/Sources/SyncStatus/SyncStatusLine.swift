import CoreKit

/// One line of the sync status banner of a signed-in scene.
enum SyncStatusLine: Hashable {

    /// Offline: `waiting` changes wait to be sent; with none, the screens show what the device kept.
    case offline(waiting: Int)
    /// `count` changes the server refused, shown until they are dismissed.
    case failed(count: Int)

    /// The lines of `state`, the offline one first; none while online with no refused change.
    static func lines(for state: SyncStatusState) -> [SyncStatusLine] {
        var lines: [SyncStatusLine] = []
        if state.offline { lines.append(.offline(waiting: state.waiting)) }
        if state.failed > 0 { lines.append(.failed(count: state.failed)) }
        return lines
    }
}
