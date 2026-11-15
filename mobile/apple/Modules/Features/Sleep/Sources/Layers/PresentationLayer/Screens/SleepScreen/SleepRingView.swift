import CoreKit
import DesignSystem
import SwiftUI

/// The day as a ring of 24 hours: the arc runs from bedtime to wake-up, with the length of the sleep and how it
/// compares with the goal in the middle.
struct SleepRingView: View {

    // MARK: - Dependencies
    let ring: SleepRing
    let isEnabled: Bool

    // MARK: - Constants
    private let size: CGFloat = 200
    private let lineWidth: CGFloat = 14
    private let minutesInDay = 1_440.0

    // MARK: - Body
    var body: some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.18), lineWidth: lineWidth)
            SleepArc(startMinutes: ring.bedMinutes, lengthMinutes: ring.durationMinutes, minutesInDay: minutesInDay)
                .stroke(arcColor, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
            ticks
            hourLabels
            marker(minutes: ring.bedMinutes, symbol: "moon.fill")
            marker(minutes: ring.wakeMinutes, symbol: ring.alarm ? "bell.fill" : "sun.max.fill")
            centre
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(summary))
    }
}

// MARK: - Subviews
private extension SleepRingView {

    var arcColor: Color {
        isEnabled ? Theme.Colors.sleep : Color.secondary.opacity(0.5)
    }

    var summary: String {
        "\(SleepFormat.time(ring.bedMinutes)) – \(SleepFormat.time(ring.wakeMinutes)), "
            + "\(SleepFormat.duration(ring.durationMinutes)), \(SleepFormat.goalDifference(ring.goalDifferenceMinutes))"
    }

    var ticks: some View {
        ForEach(0..<24, id: \.self) { hour in
            Rectangle()
                .fill(Color.secondary.opacity(0.5))
                .frame(width: hour % 6 == 0 ? 2 : 1, height: hour % 6 == 0 ? 8 : 5)
                .offset(y: -(size / 2 - lineWidth - 14))
                .rotationEffect(.degrees(Double(hour) * 15))
        }
    }

    var hourLabels: some View {
        ForEach([0, 6, 12, 18], id: \.self) { hour in
            Text(verbatim: "\(hour)")
                .font(.caption2)
                .foregroundStyle(Theme.Colors.secondaryText)
                .offset(position(minutes: hour * 60, radius: size / 2 - lineWidth - 26))
        }
    }

    func marker(minutes: Int, symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 20, height: 20)
            .background(arcColor, in: Circle())
            .offset(position(minutes: minutes, radius: size / 2 - lineWidth / 2))
    }

    var centre: some View {
        VStack(spacing: 2) {
            Text(SleepFormat.duration(ring.durationMinutes))
                .font(.headline)
            Text(SleepFormat.goalDifference(ring.goalDifferenceMinutes))
                .font(.caption)
                .foregroundStyle(ring.goalDifferenceMinutes >= 0 ? Color.green : Color.orange)
        }
        .multilineTextAlignment(.center)
        .frame(width: size - 110)
    }

    func position(minutes: Int, radius: CGFloat) -> CGSize {
        let angle = Double(minutes) / minutesInDay * 2 * .pi - .pi / 2
        return CGSize(width: radius * CGFloat(cos(angle)), height: radius * CGFloat(sin(angle)))
    }
}

// MARK: - Arc
/// An arc of the 24-hour ring: it starts at a minute of the day and runs clockwise for a number of minutes.
private struct SleepArc: Shape {

    let startMinutes: Int
    let lengthMinutes: Int
    let minutesInDay: Double

    func path(in rect: CGRect) -> Path {
        let start = Double(startMinutes) / minutesInDay * 360 - 90
        let end = start + Double(lengthMinutes) / minutesInDay * 360
        var path = Path()
        path.addArc(
            center: CGPoint(x: rect.midX, y: rect.midY),
            radius: min(rect.width, rect.height) / 2,
            startAngle: .degrees(start),
            endAngle: .degrees(end),
            clockwise: false
        )
        return path
    }
}

// MARK: - Preview
#Preview("Ring") {
    SleepRingView(
        ring: SleepRing(
            bedMinutes: 1_380, wakeMinutes: 405, durationMinutes: 465, goalDifferenceMinutes: -15, alarm: true
        ),
        isEnabled: true
    )
    .padding()
}
