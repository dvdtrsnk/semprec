import SwiftUI

/// The face inside the dial's track: a mark every quarter of an hour (longer on the hour), the even hours, the moon
/// under midnight and the sun over noon.
struct DialFace: View {

    // MARK: - Dependencies
    let geometry: DialGeometry

    // MARK: - Body
    var body: some View {
        ZStack {
            FaceMarks(radius: geometry.faceRadius * 0.95, hourLength: geometry.size * 0.022)
                .stroke(Color.secondary.opacity(0.55), lineWidth: max(1, geometry.size / 300))
            ForEach(Array(stride(from: 0, to: 24, by: 2)), id: \.self) { hour in
                Text(verbatim: "\(hour)")
                    .font(.system(size: geometry.size * 0.052, weight: .medium, design: .rounded))
                    .foregroundStyle(hour % 6 == 0 ? Color.primary : Color.secondary)
                    .offset(geometry.offset(minutes: Double(hour * 60), radius: geometry.faceRadius * 0.77))
            }
            Image(systemName: "moon.fill")
                .font(.system(size: geometry.size * 0.06))
                .foregroundStyle(Color.indigo)
                .offset(geometry.offset(minutes: 0, radius: geometry.faceRadius * 0.55))
            Image(systemName: "sun.max.fill")
                .font(.system(size: geometry.size * 0.06))
                .foregroundStyle(Color.yellow)
                .offset(geometry.offset(minutes: 720, radius: geometry.faceRadius * 0.55))
        }
        .frame(width: geometry.size, height: geometry.size)
        .accessibilityHidden(true)
    }
}

// MARK: - Marks
/// A mark every fifteen minutes around the face; the hour marks are longer.
private struct FaceMarks: Shape {

    let radius: CGFloat
    let hourLength: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let center = CGPoint(x: rect.midX, y: rect.midY)
        for quarter in 0..<96 {
            let angle = Double(quarter) / 96 * 2 * .pi
            let length = quarter % 4 == 0 ? hourLength : hourLength * 0.45
            let direction = CGPoint(x: sin(angle), y: -cos(angle))
            path.move(to: CGPoint(x: center.x + direction.x * radius, y: center.y + direction.y * radius))
            path.addLine(to: CGPoint(
                x: center.x + direction.x * (radius - length),
                y: center.y + direction.y * (radius - length)
            ))
        }
        return path
    }
}

// MARK: - Preview
#Preview("Face") {
    DialFace(geometry: DialGeometry(size: 300, stepMinutes: 5))
}
