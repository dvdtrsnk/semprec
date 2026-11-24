import CoreKit
import DesignSystem
import SwiftUI

/// The diary's pages, turned sideways as the system Calendar turns its days: the page follows the finger, with the
/// period beside it coming in from the side, and when the finger lifts past a third of the width, or after a short fast
/// flick, `onTurn` selects the period one step that way (`1` the next, `-1` the one before) and the two pages move on
/// as one. Anything less springs back. A swipe that starts along the page scrolls it instead, and one on a row of a
/// note moves the row: the row's own sideways drag takes the touch first. A period of the same kind picked on the axis
/// turns the page the same way (`request`).
///
/// Three slots of a page lie side by side, before, in and after the view, and keep their identity. The slots beside
/// the view show the periods beside the shown one (`before` and `after`) once they have been read, so a turn to one
/// of them starts at once with its page already drawn. A turn moves all three; the page that leaves keeps its views
/// and the state it showed (its note stays as it was), and the page that comes shows `current` once that shows the
/// period it came to. Once the turn ends the slots take their new places. A period not read yet waits for `current`
/// to show it; until then the page stays as it was. The pager is as tall as the page in view.
struct JournalPager<Page: View>: View {

    // MARK: - Dependencies
    let current: JournalState
    let isEnabled: Bool
    let request: JournalPageTurnRequest?
    let onTurn: (Int) -> JournalSelection?
    /// A period's page, and whether it is the page in view (the one the person works in).
    @ViewBuilder let page: (JournalState, Bool) -> Page

    // MARK: - State
    /// How far the pages are moved from their places: by the finger, or by a turn to a width either way.
    @State private var offset: CGFloat = 0
    @State private var width: CGFloat = 0
    /// The three slots: where each lies, which shows `current`, and what the others keep.
    @State private var slots = JournalPagerSlots()
    /// A turn that waits for `current` to show the period it goes to: until then the page stays as it was.
    @State private var pending: JournalPendingTurn?
    /// The last `request` taken up.
    @State private var handledRequest: Int?
    /// The last moves of the finger, for the speed it lifts at.
    @State private var samples = JournalTurnSamples()
    /// The waits a turn starts: for a page that does not come, and for a new page to be drawn before it moves. Both
    /// end with the pager.
    @State private var waitTask: Task<Void, Never>?
    @State private var moveTask: Task<Void, Never>?

    // MARK: - Body
    var body: some View {
        JournalPagerLayout(live: slots.liveSlot) {
            ForEach(0..<3, id: \.self) { slot in
                content(of: slot)
                    // A page moves as one, as a transform of all it draws: a view the page adds while it moves goes
                    // with it.
                    .modifier(JournalSlide(shift: offset + CGFloat(slots.places[slot]) * width))
                    .allowsHitTesting(slot == slots.liveSlot && slots.turning == nil)
                    .accessibilityHidden(slot != slots.liveSlot)
            }
        }
        .contentShape(.rect)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { width = $0 })
        .sidewaysDrag(in: Self.space, isEnabled: isEnabled && slots.turning == nil, RowGestureActions(
            changed: { value in
                offset = value.translation.width
                samples.add(value.translation.width)
            },
            ended: { finish() },
            cancelled: { springBack() }
        ))
        .coordinateSpace(.named(Self.space))
        .onDisappear {
            waitTask?.cancel()
            moveTask?.cancel()
        }
        .onChange(of: current.shown) { _, shown in
            if let pending, shown == pending.target { start(pending) }
        }
        .onChange(of: request) { _, request in
            guard let request else { return }
            handledRequest = request.id
            wait(for: JournalPendingTurn(
                steps: request.steps,
                target: request.target,
                leaving: request.leaving,
                from: offset,
                speed: 0
            ))
        }
    }

    /// A slot's page. Every slot that shows a page shows it in one branch, so a page keeps its views whatever slot
    /// role it takes.
    @ViewBuilder
    private func content(of slot: Int) -> some View {
        if let state = slots.state(of: slot, current: current, held: held) {
            page(state, slot == slots.liveSlot)
        } else {
            Color.clear.frame(height: 1)
        }
    }

    /// What the page in view keeps showing before its turn starts: from the moment a turn is asked for, which may
    /// come in the same update as the new period's state.
    private var held: JournalState? {
        if let request, request.id != handledRequest { return request.leaving }
        return pending?.leaving
    }

    // MARK: - Turning
    private func finish() {
        let speed = samples.speed
        samples = JournalTurnSamples()
        guard let steps = JournalPagerRules.turn(offset: offset, width: width, speed: speed) else {
            return springBack()
        }
        let shown = current
        guard let target = onTurn(steps) else { return springBack() }
        wait(for: JournalPendingTurn(steps: steps, target: target, leaving: shown, from: offset, speed: speed))
    }

    /// Starts `turn` at once when the page it goes to is drawn beside the view or `current` shows it, and otherwise
    /// once `current` does. A page that does not come (an error, a slow answer) turns all the same, to what there is.
    private func wait(for turn: JournalPendingTurn) {
        guard width > 0 else { return }
        if slots.drawn(steps: turn.steps, target: turn.target, current: current, held: held) != nil
            || current.shown == turn.target {
            return start(turn)
        }
        pending = turn
        waitTask?.cancel()
        waitTask = Task { @MainActor in
            try? await Task.sleep(for: Self.waitLimit)
            if !Task.isCancelled, pending?.id == turn.id { start(turn) }
        }
    }

    /// The page in view leaves to its side with the state it showed, and the slot on the other side comes in: the two
    /// move as one.
    private func start(_ turn: JournalPendingTurn) {
        pending = nil
        let ready = slots.drawn(steps: turn.steps, target: turn.target, current: current, held: held)
        settle()
        guard slots.begin(turn.id, steps: turn.steps, leaving: turn.leaving, ready: ready) else { return }
        // The finger's speed carries on into the turn, in shares of the way left a second.
        let target = -CGFloat(turn.steps) * width
        let way = target - offset
        let velocity = way == 0 ? 0 : turn.speed / way
        let move = {
            // Only once the pages have fully come to rest do the slots move: moved while the spring still runs, they
            // would carry the rest of its motion to their new places.
            withAnimation(
                .interpolatingSpring(duration: Self.turnDuration, bounce: 0, initialVelocity: velocity),
                completionCriteria: .removed
            ) {
                offset = target
            } completion: {
                if slots.turning == turn.id { settle() }
            }
        }
        if ready != nil { return move() }
        // A page not drawn yet is drawn where it comes from before it moves: views added in the update that animates
        // their page would be put straight where the page ends.
        moveTask?.cancel()
        moveTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(10))
            if !Task.isCancelled, slots.turning == turn.id { move() }
        }
    }

    /// The slots take their places after a turn: the page that came is in view, and the slots beside it show the
    /// periods beside it.
    private func settle() {
        guard slots.turning != nil, width > 0 else { return }
        let steps = Int((-offset / width).rounded())
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            slots.settle(movedBy: steps)
            offset = 0
        }
    }

    private func springBack() {
        samples = JournalTurnSamples()
        withAnimation(.smooth(duration: Self.turnDuration)) { offset = 0 }
    }

    // MARK: - Constants
    private static var space: String { "journal.pageTurn" }
    private static var turnDuration: Double { 0.35 }
    private static var waitLimit: Duration { .milliseconds(800) }
}

/// The decisions of the pager that depend on nothing but numbers.
enum JournalPagerRules {

    /// How far the finger has to take the page, as a share of its width, and how fast a flick has to be, in points a
    /// second, as the calendar's day.
    static let turnShare: CGFloat = 0.35
    static let flickSpeed: CGFloat = 500

    /// The turn a finger that lifts with the page moved by `offset` at `speed` asks for: `1` to the next period (the
    /// page moved left), `-1` to the one before, `nil` to spring back. It turns past `turnShare` of `width`, or after
    /// a flick faster than `flickSpeed` the way the page moved.
    static func turn(offset: CGFloat, width: CGFloat, speed: CGFloat) -> Int? {
        guard width > 0, offset != 0 else { return nil }
        let isFar = abs(offset) > width * turnShare
        let isFlick = abs(speed) > flickSpeed && offset * speed > 0
        guard isFar || isFlick else { return nil }
        return offset < 0 ? 1 : -1
    }

    /// The places of the three slots (`-1`, `0` and `1`) once the pages moved `steps` places on: the slot that came is
    /// in view, and the one that left the view on one side goes round to the other.
    static func places(_ places: [Int], afterTurning steps: Int) -> [Int] {
        places.map { place in
            let moved = place - steps
            return moved < -1 ? moved + 3 : moved > 1 ? moved - 3 : moved
        }
    }
}

/// The three slots of the pager, side by side: where each lies (`places`: `-1` before the page in view, `0` in view,
/// `1` after it), which one shows the diary's state (`liveSlot`), what the others keep through a turn (`kept`), and
/// the turn under way (`turning`), until its pages come to rest.
struct JournalPagerSlots: Equatable {

    var places = [-1, 0, 1]
    var liveSlot = 1
    var kept: [Int: JournalState] = [:]
    var turning: UUID?

    /// What `slot` shows. The live slot shows `held` (the page before a turn asked for starts) or `current`, but a page
    /// a turn brought keeps what it was drawn with until `current` shows the same period. A slot kept through a turn
    /// shows what it keeps; the others show the period beside the page in view, once it has been read.
    func state(of slot: Int, current: JournalState, held: JournalState?) -> JournalState? {
        if slot == liveSlot {
            if let drawn = kept[slot], current.shown != drawn.shown { return drawn }
            return held ?? current
        }
        if let kept = kept[slot] { return kept }
        let inView = held ?? current
        switch places[slot] {
        case -1: return inView.before.map(inView.showing)
        case 1: return inView.after.map(inView.showing)
        default: return nil
        }
    }

    /// The page of `target`, when no turn is under way and the slot on the side `steps` points to already shows it.
    func drawn(steps: Int, target: JournalSelection, current: JournalState, held: JournalState?) -> JournalState? {
        guard turning == nil, let slot = places.firstIndex(of: steps),
              let state = state(of: slot, current: current, held: held), state.shown == target else { return nil }
        return state
    }

    /// Starts turn `id` `steps` places on: the live slot keeps `leaving`, the slot on that side becomes the live one
    /// and keeps `ready` (the page already drawn there, if any). `false` when there is no slot on that side.
    mutating func begin(_ id: UUID, steps: Int, leaving: JournalState, ready: JournalState?) -> Bool {
        guard let incoming = places.firstIndex(of: steps) else { return false }
        kept[liveSlot] = leaving
        kept[incoming] = ready
        liveSlot = incoming
        turning = id
        return true
    }

    /// The pages came to rest `steps` places on: the slots take their new places and keep nothing.
    mutating func settle(movedBy steps: Int) {
        turning = nil
        places = JournalPagerRules.places(places, afterTurning: steps)
        kept = [:]
    }
}

/// Lays the pager's slots over one another at its top, each as wide as the pager and as tall as its page, and is as
/// tall as the slot `live`: the pages beside the view never make the page taller.
private struct JournalPagerLayout: Layout {

    let live: Int

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        let height = subviews.indices.contains(live)
            ? subviews[live].sizeThatFits(ProposedViewSize(width: width, height: nil)).height
            : 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            subview.place(
                at: bounds.origin,
                anchor: .topLeading,
                proposal: ProposedViewSize(width: bounds.width, height: nil)
            )
        }
    }
}

/// A turn of the page to a period already selected, from the page `leaving` showed: `steps` is `1` for a later period
/// and `-1` for an earlier one. `id` tells two turns to the same period apart.
struct JournalPageTurnRequest: Equatable {

    let id: Int
    let steps: Int
    let target: JournalSelection
    let leaving: JournalState
}

/// A turn of the page that waits for the period it goes to: the side it turns to, the state the page leaving showed,
/// and where the finger left that page and how fast it moved it.
private struct JournalPendingTurn {

    let id = UUID()
    let steps: Int
    let target: JournalSelection
    let leaving: JournalState
    let from: CGFloat
    let speed: CGFloat
}

/// Moves a page sideways by `shift`, as one transform of everything it draws.
private struct JournalSlide: GeometryEffect {

    var shift: CGFloat

    var animatableData: CGFloat {
        get { shift }
        set { shift = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: shift, y: 0))
    }
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
