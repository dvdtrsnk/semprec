import CoreKit
import DesignSystem
import SwiftUI

// MARK: - Page turn
extension View {

    /// Turns the diary's page to the neighbouring period with a sideways swipe, as the calendar's day turns to the
    /// next day: the page follows the finger, and when the finger lifts past a third of the width, or after a short
    /// fast flick, it slides out to that side, `onTurn` selects the period one step that way (`1` the next, `-1` the
    /// one before), and the new period's page slides in from the other side once it is shown (`shown`). Anything less
    /// springs back. A swipe that starts along the page scrolls it instead, and one on a row of a note moves the row:
    /// the row's own sideways drag takes the touch first.
    func journalPageTurn(
        isEnabled: Bool,
        shown: JournalSelection?,
        onTurn: @escaping (Int) -> JournalSelection?
    ) -> some View {
        modifier(JournalPageTurn(isEnabled: isEnabled, shown: shown, onTurn: onTurn))
    }
}

private struct JournalPageTurn: ViewModifier {

    // MARK: - Dependencies
    let isEnabled: Bool
    let shown: JournalSelection?
    let onTurn: (Int) -> JournalSelection?

    // MARK: - State
    @State private var offset: CGFloat = 0
    @State private var width: CGFloat = 0
    /// The period a turn went to, until its page is shown and slides in.
    @State private var awaited: JournalSelection?
    /// The last moves of the finger, for the speed it lifts at.
    @State private var samples = JournalTurnSamples()

    // MARK: - Body
    func body(content: Content) -> some View {
        content
            .contentShape(.rect)
            .offset(x: offset)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { width = $0 })
            .sidewaysDrag(in: Self.space, isEnabled: isEnabled && awaited == nil, RowGestureActions(
                changed: { value in
                    offset = value.translation.width
                    samples.add(value.translation.width)
                },
                ended: { finish() },
                cancelled: { springBack() }
            ))
            .coordinateSpace(.named(Self.space))
            .onChange(of: shown) { _, shown in
                guard let awaited, shown == awaited else { return }
                slideIn()
            }
    }

    // MARK: - Turning
    private func finish() {
        let speed = samples.speed
        samples = JournalTurnSamples()
        let isFar = abs(offset) > width * Self.turnShare
        let isFlick = abs(speed) > Self.flickSpeed && offset * speed > 0
        guard width > 0, isFar || isFlick else { return springBack() }
        let steps = offset < 0 ? 1 : -1
        withAnimation(.easeIn(duration: Self.outDuration)) {
            offset = -CGFloat(steps) * width
        } completion: {
            guard let target = onTurn(steps) else { return springBack() }
            awaited = target
            offset = CGFloat(steps) * width
            if shown == target { slideIn() }
            // A page that does not come (an error, a slow answer) slides in all the same, with what is there.
            Task { @MainActor in
                try? await Task.sleep(for: Self.waitLimit)
                if awaited == target { slideIn() }
            }
        }
    }

    private func slideIn() {
        awaited = nil
        withAnimation(.smooth(duration: Self.inDuration)) { offset = 0 }
    }

    private func springBack() {
        samples = JournalTurnSamples()
        withAnimation(.smooth(duration: Self.inDuration)) { offset = 0 }
    }

    // MARK: - Constants
    private static let space = "journal.pageTurn"
    /// How far the finger has to take the page, as a share of its width, and how fast a flick has to be, in points a
    /// second, as the calendar's day.
    private static let turnShare: CGFloat = 0.35
    private static let flickSpeed: CGFloat = 500
    private static let outDuration = 0.18
    private static let inDuration = 0.3
    private static let waitLimit: Duration = .milliseconds(800)
}

/// The finger's last positions with their times, for the speed it lifts at.
private struct JournalTurnSamples {

    private var points: [(position: CGFloat, time: TimeInterval)] = []

    mutating func add(_ position: CGFloat) {
        let now = Date.timeIntervalSinceReferenceDate
        points.append((position, now))
        points.removeAll { now - $0.time > 0.1 }
    }

    /// Points a second over the last tenth of a second.
    var speed: CGFloat {
        guard let first = points.first, let last = points.last, last.time > first.time else { return 0 }
        return (last.position - first.position) / CGFloat(last.time - first.time)
    }
}
