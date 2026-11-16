import CoreKit
import DesignSystem
import SwiftUI

/// The floating bubble of Semp. A tap opens the chat; dragging moves it to an edge of the screen; dragging it onto an
/// object that can be given to Semp and holding there lets the object go into Semp. What is given to Semp is decided in
/// Kotlin; this view follows the finger, finds the object under it and animates.
struct SempBubbleScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SempBubbleViewModel
    private let registry: DropTargetRegistry
    private let zoom: Namespace.ID?
    private let open: () -> Void

    // MARK: - Properties
    @AppStorage("semp.bubble.side")
    private var sideName = SempBubbleSide.right.rawValue
    @AppStorage("semp.bubble.y")
    private var restingY: Double = -1
    @State private var drag = SempBubbleDrag()

    // MARK: - Init
    /// `registry` holds the objects of the presentation the bubble floats over; `open` shows the chat; `zoom` is the
    /// namespace in which the bubble is the source the chat zooms out of (`SempScreenFactory.bubbleTransitionID`).
    init(
        viewModel: @autoclosure @escaping () -> SempBubbleViewModel,
        registry: DropTargetRegistry,
        zoom: Namespace.ID?,
        open: @escaping () -> Void
    ) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.registry = registry
        self.zoom = zoom
        self.open = open
    }

    // MARK: - Body
    var body: some View {
        GeometryReader { proxy in
            let placement = SempBubblePlacement(size: proxy.size)
            let origin = proxy.frame(in: .global).origin
            ZStack(alignment: .topLeading) {
                if let hover = drag.hover { highlight(hover.frame, origin: origin) }
                bubble(placement)
                    .position(center(placement))
                    .gesture(dragGesture(placement, origin: origin))
                if let toast = viewModel.state.toast { toastView(toast).frame(maxWidth: .infinity, alignment: .top) }
            }
        }
        .task { await viewModel.observe() }
        .sensoryFeedback(.impact, trigger: drag.armed)
        .sensoryFeedback(.success, trigger: viewModel.state.toast)
    }
}

// MARK: - Subviews
private extension SempBubbleScreen {

    var side: SempBubbleSide {
        SempBubbleSide(rawValue: sideName) ?? .right
    }

    func center(_ placement: SempBubblePlacement) -> CGPoint {
        let radius = SempBubblePlacement.diameter / 2
        if let point = drag.center { return CGPoint(x: point.x, y: point.y) }
        let top = restingY < 0 ? placement.yRange.upperBound : placement.rest(top: restingY)
        return CGPoint(x: placement.x(for: side) + radius, y: top + radius)
    }

    func bubble(_ placement: SempBubblePlacement) -> some View {
        ZStack {
            Image(systemName: "sparkles").font(.title2.weight(.semibold)).foregroundStyle(.primary)
            if viewModel.state.badge > 0 { badge(viewModel.state.badge).offset(badgeOffset(placement)) }
            if viewModel.state.attachments > 0 { attachments(viewModel.state.attachments) }
        }
        .frame(width: SempBubblePlacement.diameter, height: SempBubblePlacement.diameter)
        .glassEffect(.regular.interactive(), in: Circle())
        .zoomSource(SempScreenFactory.bubbleTransitionID, in: zoom)
        .overlay(Circle().stroke(Theme.Colors.accent, lineWidth: drag.armed ? 3 : 0))
        .scaleEffect(drag.armed ? 1.1 : (drag.moved ? 1.06 : 1))
        .animation(.spring(duration: 0.3, bounce: 0.4), value: drag.armed)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(Text("semp.bubble.hint", bundle: .module))
        .accessibilityAction { open() }
        .accessibilityIdentifier(SempIdentifiers.bubble)
    }

    func badge(_ count: Int) -> some View {
        Text(count > 9 ? "9+" : String(count))
            .font(.caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .frame(minWidth: 18, minHeight: 18)
            .background(Theme.Colors.destructive, in: Capsule())
    }

    func attachments(_ count: Int) -> some View {
        Label(String(count), systemImage: "paperclip")
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Theme.Colors.accent, in: Capsule())
            .foregroundStyle(.white)
            .offset(y: SempBubblePlacement.diameter / 2 + 4)
    }

    func badgeOffset(_ placement: SempBubblePlacement) -> CGSize {
        let onLeft = (drag.center.map { $0.x < placement.size.width / 2 } ?? (side == .left))
        return CGSize(width: onLeft ? 24 : -24, height: -22)
    }

    func highlight(_ frame: CGRect, origin: CGPoint) -> some View {
        RoundedRectangle(cornerRadius: 12)
            .stroke(Theme.Colors.accent.opacity(drag.armed ? 0.9 : 0.5), lineWidth: 2)
            .background(Theme.Colors.accent.opacity(drag.armed ? 0.12 : 0.05), in: RoundedRectangle(cornerRadius: 12))
            .frame(width: frame.width, height: frame.height)
            .position(x: frame.midX - origin.x, y: frame.midY - origin.y)
            .allowsHitTesting(false)
    }

    func toastView(_ toast: SempBubbleToast) -> some View {
        Label(toastText(toast), systemImage: toast == .cannotAdd ? "exclamationmark.circle" : "checkmark.circle.fill")
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .glassEffect(.regular, in: Capsule())
            .padding(.top, SempBubblePlacement.margin)
            .allowsHitTesting(false)
            .accessibilityIdentifier(SempIdentifiers.bubbleToast)
    }

    func toastText(_ toast: SempBubbleToast) -> String {
        switch toast {
        case .added: String(localized: "semp.bubble.toast.added", bundle: .module)
        case .alreadyAdded: String(localized: "semp.bubble.toast.already", bundle: .module)
        case .cannotAdd: String(localized: "semp.bubble.toast.cannot", bundle: .module)
        case .newThread: String(localized: "semp.bubble.toast.newThread", bundle: .module)
        case .continueThread: String(localized: "semp.bubble.toast.continueThread", bundle: .module)
        }
    }

    var accessibilityLabel: String {
        let state = viewModel.state
        var text = state.badge > 0
            ? String(
                format: String(localized: "semp.bubble.label.waiting", bundle: .module),
                locale: .current,
                state.badge
            )
            : String(localized: "semp.bubble.label", bundle: .module)
        if state.attachments > 0 {
            text += " " + String(
                format: String(localized: "semp.bubble.label.attached", bundle: .module),
                locale: .current,
                state.attachments
            )
        }
        return text
    }
}

// MARK: - Dragging
private extension SempBubbleScreen {

    func dragGesture(_ placement: SempBubblePlacement, origin: CGPoint) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { value in
                if drag.start == nil {
                    drag.start = center(placement)
                    drag.startedAt = Date()
                }
                guard let start = drag.start else { return }
                let travelled = hypot(value.translation.width, value.translation.height)
                guard drag.moved || travelled >= 6 else { return }
                drag.moved = true
                let radius = SempBubblePlacement.diameter / 2
                drag.center = CGPoint(
                    x: min(max(start.x + value.translation.width, -radius / 2), placement.size.width + radius / 2),
                    y: min(max(start.y + value.translation.height, radius), placement.size.height - radius / 2)
                )
                hover(at: value.location)
            }
            .onEnded { value in finish(value, placement: placement) }
    }

    func hover(at point: CGPoint) {
        let found = registry.target(at: point)
        let target = found.flatMap { entry in
            (entry.payload as? SempTarget).map { SempBubbleHover(frame: entry.frame, target: $0) }
        }
        guard target != drag.hover else { return }
        drag.hover = target
        drag.armed = false
        drag.dwell?.cancel()
        guard target != nil else { return }
        drag.dwell = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(550))
            if !Task.isCancelled, drag.hover == target { drag.armed = true }
        }
    }

    func finish(_ value: DragGesture.Value, placement: SempBubblePlacement) {
        let armedTarget = drag.armed ? drag.hover?.target : nil
        let moved = drag.moved
        let tapped = !moved && Date().timeIntervalSince(drag.startedAt ?? .now) < 0.5
        let last = drag.center
        drag.dwell?.cancel()
        withAnimation(.spring(duration: 0.5, bounce: 0.45)) {
            drag = SempBubbleDrag()
            if moved, armedTarget == nil, let last {
                let velocityX = (value.predictedEndLocation.x - value.location.x) / SempBubblePlacement.throwSeconds
                sideName = placement.side(centerX: last.x, velocityX: velocityX).rawValue
                restingY = Double(placement.rest(top: last.y - SempBubblePlacement.diameter / 2))
            }
        }
        if let armedTarget {
            viewModel.drop(armedTarget)
        } else if tapped {
            open()
        }
    }
}

// MARK: - Drag state
/// Where the bubble is while it is held, and what is under the finger.
private struct SempBubbleDrag {

    var start: CGPoint?
    var startedAt: Date?
    var center: CGPoint?
    var moved = false
    var hover: SempBubbleHover?
    var armed = false
    var dwell: Task<Void, Never>?
}

private struct SempBubbleHover: Equatable {

    let frame: CGRect
    let target: SempTarget
}

// MARK: - Zoom source
private extension View {

    /// Makes the view the source a presentation zooms out of and back into, on iOS, where the zoom transition exists.
    @ViewBuilder
    func zoomSource(_ id: String, in namespace: Namespace.ID?) -> some View {
        #if os(iOS)
        if let namespace {
            matchedTransitionSource(id: id, in: namespace) { source in
                source.clipShape(RoundedRectangle(cornerRadius: SempBubblePlacement.diameter / 2))
            }
        } else {
            self
        }
        #else
        self
        #endif
    }
}
