import CoreKit
import DesignSystem
import SwiftUI

/// The 24-hour dial of the sleep editors: midnight at the top, the hours clockwise, and the night as a snake on the
/// dark track from the bed end to the wake end. Dragging an end moves that time, dragging the body moves the whole
/// night. The dial only draws the shared draft and turns a drag into `moveDial` actions: which times those become
/// (steps, wrapping, the length of the night) is decided by the shared ViewModel. A step ticks, and the snake turns
/// orange while the night misses the goal.
struct SleepDial: View {

    // MARK: - Dependencies
    let draft: SleepDraft
    let send: (SleepAction) -> Void
    /// Runs when a drag that moved the snake ends, or an accessibility adjustment moved it.
    var onEnd: () -> Void = {}

    // MARK: - State
    @GestureState private var grab: DialGrab?
    @Environment(\.colorScheme)
    private var colorScheme

    // MARK: - Body
    var body: some View {
        GeometryReader { proxy in
            let geometry = DialGeometry(size: min(proxy.size.width, proxy.size.height), stepMinutes: draft.stepMinutes)
            ZStack {
                Circle().fill(trackColor)
                Circle()
                    .fill(Theme.Colors.card)
                    .frame(width: geometry.faceRadius * 2, height: geometry.faceRadius * 2)
                DialFace(geometry: geometry)
                snake(geometry)
            }
            .frame(width: geometry.size, height: geometry.size)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(1, contentMode: .fit)
        .sensoryFeedback(.selection, trigger: draft.bedMinutes)
        .sensoryFeedback(.selection, trigger: draft.wakeMinutes)
        .overlay { adjustableEnds }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: accessibilitySummary))
        .accessibilityIdentifier(SleepIdentifiers.dial)
    }
}

// MARK: - Subviews
private extension SleepDial {

    var accessibilitySummary: String {
        String(
            format: String(localized: "sleep.dial.a11y", bundle: .module),
            locale: .current,
            SleepFormat.time(draft.bedMinutes),
            SleepFormat.time(draft.wakeMinutes),
            SleepFormat.duration(draft.durationMinutes),
            SleepFormat.goalDifference(draft.goalDifferenceMinutes)
        )
    }

    var trackColor: Color {
        colorScheme == .dark ? .black : Color(white: 0.9)
    }

    var snakeColor: Color {
        draft.meetsGoal ? Theme.Colors.card : .orange
    }

    /// Only a shade darker than the snake, as on the system's dial.
    var markColor: Color {
        draft.meetsGoal ? Color.black.opacity(colorScheme == .dark ? 0.38 : 0.16) : Color.black.opacity(0.18)
    }

    var iconColor: Color {
        draft.meetsGoal ? Color(white: 0.56) : Color(red: 0.55, green: 0.22, blue: 0.05)
    }

    func snake(_ geometry: DialGeometry) -> some View {
        let start = Double(draft.bedMinutes)
        let length = Double(draft.durationMinutes)
        return ZStack {
            SnakeArc(startMinutes: start, lengthMinutes: length, radius: geometry.snakeRadius)
                .stroke(snakeColor, style: StrokeStyle(lineWidth: geometry.snakeWidth, lineCap: .round))
            SnakeMarks(
                startMinutes: start,
                lengthMinutes: length,
                stepMinutes: draft.stepMinutes,
                radius: geometry.snakeRadius,
                markLength: geometry.snakeWidth * 0.37,
                inset: geometry.knobInsetMinutes
            )
            .stroke(markColor, style: StrokeStyle(lineWidth: geometry.stepArc * 0.5, lineCap: .round))
            knob("bed.double.fill", minutes: start, geometry: geometry)
            knob("alarm", minutes: start + length, geometry: geometry)
        }
        .frame(width: geometry.size, height: geometry.size)
        // Only the snake takes a drag, so the rest of the dial scrolls the editor.
        .contentShape(
            SnakeArc(startMinutes: start, lengthMinutes: length, radius: geometry.snakeRadius)
                .stroke(style: StrokeStyle(lineWidth: geometry.snakeWidth * 1.4, lineCap: .round))
        )
        .highPriorityGesture(dragGesture(geometry))
    }

    func knob(_ symbol: String, minutes: Double, geometry: DialGeometry) -> some View {
        Image(systemName: symbol)
            .font(.system(size: geometry.snakeWidth * 0.36, weight: .semibold))
            .foregroundStyle(iconColor)
            .offset(geometry.offset(minutes: minutes, radius: geometry.snakeRadius))
    }

    /// A drag sends the time of the held part whenever it reaches another step. `@GestureState` ends the grab when
    /// the drag ends or is interrupted, so nothing is left behind.
    func dragGesture(_ geometry: DialGeometry) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .updating($grab) { value, grab, _ in
                if grab == nil {
                    grab = DialGrab.start(at: value.startLocation, geometry: geometry, draft: draft)
                }
                guard var held = grab else { return }
                let target = held.target(at: value.location, geometry: geometry)
                guard let minutes = held.move(to: target, stepMinutes: draft.stepMinutes) else { return }
                send(.draft(.moveDial(held.handle, minutes: minutes)))
                grab = held
            }
            .onEnded { _ in onEnd() }
    }

    /// The two ends as adjustable elements for VoiceOver: swiping up or down moves the end by one step.
    var adjustableEnds: some View {
        VStack {
            adjustable(
                title: Text("sleep.editor.bed", bundle: .module),
                minutes: draft.bedMinutes,
                handle: .bed,
                identifier: SleepIdentifiers.dialBed
            )
            adjustable(
                title: draft.alarm
                    ? Text("sleep.editor.alarm", bundle: .module)
                    : Text("sleep.editor.wakeNoAlarm", bundle: .module),
                minutes: draft.wakeMinutes,
                handle: .wake,
                identifier: SleepIdentifiers.dialWake
            )
        }
        .allowsHitTesting(false)
    }

    func adjustable(title: Text, minutes: Int, handle: SleepDialHandle, identifier: String) -> some View {
        Color.clear
            .frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityLabel(title)
            .accessibilityValue(Text(verbatim: SleepFormat.time(minutes)))
            .accessibilityAdjustableAction { direction in
                switch direction {
                case .increment: actions.adjust(handle, at: minutes, stepMinutes: draft.stepMinutes, isLater: true)
                case .decrement: actions.adjust(handle, at: minutes, stepMinutes: draft.stepMinutes, isLater: false)
                @unknown default: break
                }
            }
            .accessibilityIdentifier(identifier)
    }

    var actions: SleepDialActions {
        SleepDialActions(send: send, onEnd: onEnd)
    }
}

// MARK: - Preview
#Preview("Dial") {
    SleepDial(draft: .previewWeekdays, send: { _ in })
        .padding()
}

#Preview("Dial below the goal") {
    SleepDial(draft: .previewShort, send: { _ in })
        .padding()
}
