import CoreKit
import DesignSystem
import SwiftUI

/// The bubble of Semp. A tap opens the chat; dragging it onto an object that can be given to Semp and holding there
/// lets the object go into Semp. It either floats, and dragging moves it to an edge of the screen, or it is docked in
/// a place the app gives it (Semp's button in the tab bar, which the system draws), where it shows only what the
/// button lacks and, let go anywhere, springs back into that place. What is given to Semp is decided in Kotlin; this
/// view follows the finger, finds the object under it and animates.
struct SempBubbleScreen: View {

    // MARK: - Dependencies
    @StateObject private var viewModel: SempBubbleViewModel
    private let registry: DropTargetRegistry
    private let dock: CGRect?
    private let zoom: Namespace.ID?
    private let open: () -> Void
    private let reportFrame: (CGRect) -> Void

    // MARK: - Properties
    @AppStorage("semp.bubble.side")
    private var sideName = SempBubbleSide.right.rawValue
    @AppStorage("semp.bubble.y")
    private var restingY: Double = -1
    @State private var drag = SempBubbleDrag()
    /// Set while a bubble let go is on its way back into its dock, where it is shown until it arrives.
    @State private var returning = false
    /// Clears `returning` once the bubble is back; a release while one is pending replaces it.
    @State private var returningEnd: Task<Void, Never>?

    // MARK: - Init
    /// `registry` holds the objects the bubble can be dragged onto; `dock` is the place it is docked in, in global
    /// coordinates, or nil while it floats; `open` shows the chat; `zoom` is the namespace in which the bubble is the
    /// source the chat zooms out of (`SempScreenFactory.bubbleTransitionID`); `reportFrame` is told the bubble's frame
    /// in global coordinates whenever it changes.
    init(
        viewModel: @autoclosure @escaping () -> SempBubbleViewModel,
        registry: DropTargetRegistry,
        dock: CGRect?,
        zoom: Namespace.ID?,
        open: @escaping () -> Void,
        reportFrame: @escaping (CGRect) -> Void = { _ in }
    ) {
        _viewModel = StateObject(wrappedValue: viewModel())
        self.registry = registry
        self.dock = dock
        self.zoom = zoom
        self.open = open
        self.reportFrame = reportFrame
    }

    // MARK: - Body
    var body: some View {
        GeometryReader { proxy in
            let placement = SempBubblePlacement(size: proxy.size)
            let origin = proxy.frame(in: .global).origin
            let center = center(placement, origin: origin)
            ZStack(alignment: .topLeading) {
                if let hover = drag.hover { highlight(hover.frame, origin: origin) }
                bubble(placement, center: center)
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { reportFrame($0) }
                    .position(center)
                    .animation(.spring(duration: 0.5, bounce: 0.25), value: dock)
                    .gesture(dragGesture(placement, origin: origin))
                if let toast = viewModel.state.toast { toastView(toast).frame(maxWidth: .infinity, alignment: .top) }
            }
        }
        .task { await viewModel.observe() }
        .haptic(.standard, trigger: drag.armed)
        .sensoryFeedback(.success, trigger: viewModel.state.toast)
    }
}

// MARK: - Subviews
private extension SempBubbleScreen {

    var side: SempBubbleSide {
        SempBubbleSide(rawValue: sideName) ?? .right
    }

    /// Whether the bubble draws its glass and icon: always while it floats, and while it is held or on its way back
    /// when docked, where the button the bubble sits on draws them otherwise.
    var showsFace: Bool {
        dock == nil || drag.moved || returning
    }

    var diameter: CGFloat {
        dock?.width ?? SempBubblePlacement.diameter
    }

    func center(_ placement: SempBubblePlacement, origin: CGPoint) -> CGPoint {
        let radius = SempBubblePlacement.diameter / 2
        if let point = drag.center { return CGPoint(x: point.x, y: point.y) }
        if let dock { return CGPoint(x: dock.midX - origin.x, y: dock.midY - origin.y) }
        let top = restingY < 0 ? placement.yRange.upperBound : placement.rest(top: restingY)
        return CGPoint(x: placement.x(for: side) + radius, y: top + radius)
    }

    func bubble(_ placement: SempBubblePlacement, center: CGPoint) -> some View {
        ZStack {
            Image(systemName: "sparkles")
                .font(.title2.weight(.semibold))
                .foregroundStyle(.primary)
                .opacity(showsFace ? 1 : 0)
            if viewModel.state.badge > 0 { badge(viewModel.state.badge).offset(badgeOffset(placement, center: center)) }
            if viewModel.state.attachments > 0 { attachments(viewModel.state.attachments) }
        }
        .frame(width: diameter, height: diameter)
        .contentShape(Circle())
        .glassEffect(showsFace ? .regular.interactive() : .identity, in: Circle())
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
            .offset(y: diameter / 2 + 4)
    }

    /// The badge sits on the corner of the bubble that faces the middle of the screen.
    func badgeOffset(_ placement: SempBubblePlacement, center: CGPoint) -> CGSize {
        CGSize(width: center.x < placement.size.width / 2 ? 24 : -24, height: -22)
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
                    drag.start = center(placement, origin: origin)
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
        let docked = dock != nil
        withAnimation(.spring(duration: 0.5, bounce: 0.45)) {
            drag = SempBubbleDrag()
            returning = docked && moved
            if moved, !docked, armedTarget == nil, let last {
                let velocityX = (value.predictedEndLocation.x - value.location.x) / SempBubblePlacement.throwSeconds
                sideName = placement.side(centerX: last.x, velocityX: velocityX).rawValue
                restingY = Double(placement.rest(top: last.y - SempBubblePlacement.diameter / 2))
            }
        }
        returningEnd?.cancel()
        returningEnd = nil
        if docked, moved {
            returningEnd = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(450))
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: 0.15)) { returning = false }
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
