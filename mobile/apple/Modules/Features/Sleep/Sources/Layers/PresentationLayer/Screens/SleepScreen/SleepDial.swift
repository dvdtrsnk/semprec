import DesignSystem
import SwiftUI

/// The 24-hour dial of the schedule editor: midnight at the top, the hours clockwise, and the schedule as a snake on
/// the dark track from the bed end to the alarm end. Dragging an end moves that time, dragging the body moves the
/// whole schedule; every time lands on a five-minute step, which the marks inside the snake show, and each step
/// ticks. The snake turns orange while the schedule is shorter than the goal.
struct SleepDial: View {

    // MARK: - Dependencies
    @Binding var draft: SleepScheduleDraft
    let meetsGoal: Bool
    /// Runs when a drag on the snake starts.
    var onStart: () -> Void = {}
    /// Runs when a drag that moved the snake ends.
    var onEnd: () -> Void = {}

    // MARK: - State
    @State private var drag: DialDrag?
    @Environment(\.colorScheme)
    private var colorScheme

    // MARK: - Body
    var body: some View {
        GeometryReader { proxy in
            let geometry = DialGeometry(size: min(proxy.size.width, proxy.size.height))
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: accessibilitySummary))
        .accessibilityIdentifier(SleepIdentifiers.dial)
    }
}

// MARK: - Subviews
private extension SleepDial {

    var accessibilitySummary: String {
        "\(SleepFormat.time(draft.bedMinutes)) – \(SleepFormat.time(draft.wakeMinutes))"
    }

    var trackColor: Color {
        colorScheme == .dark ? .black : Color(white: 0.9)
    }

    var snakeColor: Color {
        meetsGoal ? Theme.Colors.card : .orange
    }

    /// Only a shade darker than the snake, as on the system's dial.
    var markColor: Color {
        meetsGoal ? Color.black.opacity(colorScheme == .dark ? 0.38 : 0.16) : Color.black.opacity(0.18)
    }

    var iconColor: Color {
        meetsGoal ? Color(white: 0.56) : Color(red: 0.55, green: 0.22, blue: 0.05)
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

    func dragGesture(_ geometry: DialGeometry) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                let minutes = geometry.minutes(at: value.location)
                if drag == nil {
                    drag = DialDrag.start(at: value.startLocation, geometry: geometry, draft: draft)
                    if drag != nil { onStart() }
                }
                guard let drag else { return }
                let target = Int((minutes + drag.offsetMinutes).rounded())
                // No animation: the snake jumps from step to step, as the marks and the ticks of the haptics do.
                switch drag.part {
                case .bed: draft.moveBed(to: target)
                case .wake: draft.moveWake(to: target)
                case .body: draft.moveAll(bedTo: target)
                }
            }
            .onEnded { _ in
                if drag != nil { onEnd() }
                drag = nil
            }
    }
}

// MARK: - Drag
/// Which part of the snake a drag holds, and how far the finger was from that part's time when it began, so the
/// part does not jump under the finger.
private struct DialDrag {

    enum Part {
        case bed
        case wake
        case body
    }

    let part: Part
    let offsetMinutes: Double

    static func start(at point: CGPoint, geometry: DialGeometry, draft: SleepScheduleDraft) -> DialDrag? {
        guard geometry.isOnTrack(point) else { return nil }
        let finger = geometry.minutes(at: point)
        let bed = Double(draft.bedMinutes)
        let wake = Double(draft.wakeMinutes)
        let reach = geometry.knobInsetMinutes * 1.6
        let toBed = abs(Double(SleepScheduleDraft.signedDistance(from: Int(finger), to: Int(bed))))
        let toWake = abs(Double(SleepScheduleDraft.signedDistance(from: Int(finger), to: Int(wake))))
        if toBed <= reach || toWake <= reach {
            return toBed <= toWake
                ? DialDrag(part: .bed, offsetMinutes: delta(from: finger, to: bed))
                : DialDrag(part: .wake, offsetMinutes: delta(from: finger, to: wake))
        }
        let along = Double(SleepScheduleDraft.wrapped(Int(finger) - draft.bedMinutes))
        guard along <= Double(draft.durationMinutes) else { return nil }
        return DialDrag(part: .body, offsetMinutes: delta(from: finger, to: bed))
    }

    static func delta(from finger: Double, to minutes: Double) -> Double {
        Double(SleepScheduleDraft.signedDistance(from: Int(finger.rounded()), to: Int(minutes)))
    }
}

// MARK: - Geometry
/// Where the parts of the dial are for one size.
struct DialGeometry {

    let size: CGFloat

    // The proportions of the system's own sleep schedule dial, measured on its screenshots.
    var radius: CGFloat { size / 2 }
    var faceRadius: CGFloat { radius * 0.717 }
    var trackWidth: CGFloat { radius - faceRadius }
    var snakeWidth: CGFloat { radius * 0.235 }
    var snakeRadius: CGFloat { radius * 0.874 }

    /// The length of one five-minute step along the middle of the snake.
    var stepArc: CGFloat {
        snakeRadius * 2 * .pi * CGFloat(SleepScheduleDraft.stepMinutes) / CGFloat(SleepScheduleDraft.minutesInDay)
    }

    /// How many minutes of the dial a round end of the snake covers past its time.
    var knobInsetMinutes: Double {
        Double(snakeWidth * 0.62 / snakeRadius) / (2 * .pi) * Double(SleepScheduleDraft.minutesInDay)
    }

    /// The minute of the day at `point`, 0 at the top, clockwise.
    func minutes(at point: CGPoint) -> Double {
        let angle = atan2(Double(point.x - radius), Double(radius - point.y))
        let turn = angle < 0 ? angle + 2 * .pi : angle
        return turn / (2 * .pi) * Double(SleepScheduleDraft.minutesInDay)
    }

    func isOnTrack(_ point: CGPoint) -> Bool {
        let distance = hypot(point.x - radius, point.y - radius)
        return distance >= faceRadius - trackWidth * 0.25 && distance <= radius + trackWidth * 0.25
    }

    func offset(minutes: Double, radius: CGFloat) -> CGSize {
        let angle = minutes / Double(SleepScheduleDraft.minutesInDay) * 2 * .pi
        return CGSize(width: radius * CGFloat(sin(angle)), height: -radius * CGFloat(cos(angle)))
    }
}

// MARK: - Shapes
/// The body of the snake: an arc of the dial from a minute of the day, clockwise, for a number of minutes.
private struct SnakeArc: Shape {

    var startMinutes: Double
    var lengthMinutes: Double
    let radius: CGFloat

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(startMinutes, lengthMinutes) }
        set {
            startMinutes = newValue.first
            lengthMinutes = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        let start = startMinutes / Double(SleepScheduleDraft.minutesInDay) * 360 - 90
        let end = start + lengthMinutes / Double(SleepScheduleDraft.minutesInDay) * 360
        var path = Path()
        path.addArc(
            center: CGPoint(x: rect.midX, y: rect.midY),
            radius: radius,
            startAngle: .degrees(start),
            endAngle: .degrees(end),
            clockwise: false
        )
        return path
    }
}

/// The marks inside the snake: one across it at every five minutes of the day between its two round ends.
private struct SnakeMarks: Shape {

    var startMinutes: Double
    var lengthMinutes: Double
    let radius: CGFloat
    let markLength: CGFloat
    let inset: Double

    var animatableData: AnimatablePair<Double, Double> {
        get { AnimatablePair(startMinutes, lengthMinutes) }
        set {
            startMinutes = newValue.first
            lengthMinutes = newValue.second
        }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let step = Double(SleepScheduleDraft.stepMinutes)
        let first = ((startMinutes + inset) / step).rounded(.up) * step
        let last = startMinutes + lengthMinutes - inset
        guard first <= last else { return path }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        for minute in stride(from: first, through: last, by: step) {
            let angle = minute / Double(SleepScheduleDraft.minutesInDay) * 2 * .pi
            let direction = CGPoint(x: sin(angle), y: -cos(angle))
            let inner = radius - markLength / 2
            let outer = radius + markLength / 2
            path.move(to: CGPoint(x: center.x + direction.x * inner, y: center.y + direction.y * inner))
            path.addLine(to: CGPoint(x: center.x + direction.x * outer, y: center.y + direction.y * outer))
        }
        return path
    }
}
