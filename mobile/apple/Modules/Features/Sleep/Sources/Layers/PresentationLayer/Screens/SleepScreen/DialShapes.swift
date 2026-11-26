import SwiftUI

/// The body of the snake: an arc of the dial from a minute of the day, clockwise, for a number of minutes.
struct SnakeArc: Shape {

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
        let start = startMinutes / DialGeometry.minutesInDay * 360 - 90
        let end = start + lengthMinutes / DialGeometry.minutesInDay * 360
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

/// The marks inside the snake: one across it at every step of the day between its two round ends.
struct SnakeMarks: Shape {

    var startMinutes: Double
    var lengthMinutes: Double
    let stepMinutes: Int
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
        let step = Double(stepMinutes)
        let first = ((startMinutes + inset) / step).rounded(.up) * step
        let last = startMinutes + lengthMinutes - inset
        guard step > 0, first <= last else { return path }
        let center = CGPoint(x: rect.midX, y: rect.midY)
        for minute in stride(from: first, through: last, by: step) {
            let angle = minute / DialGeometry.minutesInDay * 2 * .pi
            let direction = CGPoint(x: sin(angle), y: -cos(angle))
            let inner = radius - markLength / 2
            let outer = radius + markLength / 2
            path.move(to: CGPoint(x: center.x + direction.x * inner, y: center.y + direction.y * inner))
            path.addLine(to: CGPoint(x: center.x + direction.x * outer, y: center.y + direction.y * outer))
        }
        return path
    }
}
