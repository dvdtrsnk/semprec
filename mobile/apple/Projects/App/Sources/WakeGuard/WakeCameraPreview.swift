import DesignSystem
import SwiftUI

/// The camera's picture inside a rounded viewfinder with corner marks, or why there is none. The marks turn red for a
/// moment when the camera read a code that is not one of the mission's.
struct WakeCameraPreview: View {

    // MARK: - Dependencies
    let frame: CGImage?
    let state: CodeScanner.CameraState
    let rejected: Bool
    let openSettings: () -> Void

    // MARK: - Body
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(.white.opacity(0.08))
            content
            ViewfinderCorners()
                .stroke(rejected ? Color.red : Color.white, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                .padding(Theme.Spacing.large)
                .animation(.easeOut(duration: 0.2), value: rejected)
        }
        .aspectRatio(3 / 4, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay(alignment: .bottom) {
            if rejected {
                Text("wake.scan.wrong")
                    .font(.callout.weight(.semibold))
                    .padding(.horizontal, Theme.Spacing.medium)
                    .padding(.vertical, Theme.Spacing.small)
                    .background(.red, in: Capsule())
                    .foregroundStyle(.white)
                    .padding(Theme.Spacing.medium)
                    .transition(.opacity)
            }
        }
    }
}

// MARK: - Subviews
private extension WakeCameraPreview {

    @ViewBuilder var content: some View {
        switch state {
        case .running, .starting:
            if let frame {
                Image(decorative: frame, scale: 1).resizable().scaledToFill()
            } else {
                ProgressView().tint(.white)
            }
        case .denied:
            message("wake.camera.denied") {
                Button(action: openSettings) { Text("wake.camera.settings") }
                    .buttonStyle(.borderedProminent)
            }
        case .unavailable:
            message("wake.camera.unavailable") { EmptyView() }
        }
    }

    func message<Action: View>(_ key: LocalizedStringKey, @ViewBuilder action: () -> Action) -> some View {
        VStack(spacing: Theme.Spacing.medium) {
            Image(systemName: "camera.fill").font(.largeTitle)
            Text(key).multilineTextAlignment(.center)
            action()
        }
        .foregroundStyle(.white)
        .padding(Theme.Spacing.large)
    }
}

/// The four corner marks of a viewfinder.
private struct ViewfinderCorners: Shape {

    func path(in rect: CGRect) -> Path {
        let length = min(rect.width, rect.height) * 0.18
        var path = Path()
        for (corner, horizontal, vertical) in [
            (CGPoint(x: rect.minX, y: rect.minY), 1.0, 1.0),
            (CGPoint(x: rect.maxX, y: rect.minY), -1.0, 1.0),
            (CGPoint(x: rect.minX, y: rect.maxY), 1.0, -1.0),
            (CGPoint(x: rect.maxX, y: rect.maxY), -1.0, -1.0)
        ] {
            path.move(to: CGPoint(x: corner.x + horizontal * length, y: corner.y))
            path.addLine(to: corner)
            path.addLine(to: CGPoint(x: corner.x, y: corner.y + vertical * length))
        }
        return path
    }
}
