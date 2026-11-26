import SwiftUI

/// The picture of a camera inside a rounded frame with corner marks. The marks turn red while `isRejected`. `message`
/// takes the place of the picture when the camera cannot run.
public struct Viewfinder<Message: View>: View {

    // MARK: - Dependencies
    private let frame: CGImage?
    private let isRejected: Bool
    private let message: Message?

    // MARK: - Init
    /// The camera's picture, or a progress indicator until the first frame arrives.
    public init(frame: CGImage?, isRejected: Bool = false) where Message == EmptyView {
        self.frame = frame
        self.isRejected = isRejected
        message = nil
    }

    /// `message` instead of a picture.
    public init(isRejected: Bool = false, @ViewBuilder message: () -> Message) {
        frame = nil
        self.isRejected = isRejected
        self.message = message()
    }

    // MARK: - Body
    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 28, style: .continuous).fill(.white.opacity(0.08))
            content
            ViewfinderCorners()
                .stroke(isRejected ? Color.red : Color.white, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                .padding(Theme.Spacing.large)
                .animation(.easeOut(duration: 0.2), value: isRejected)
        }
        .aspectRatio(3 / 4, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
    }
}

// MARK: - Subviews
private extension Viewfinder {

    @ViewBuilder var content: some View {
        if let message {
            message
        } else if let frame {
            Image(decorative: frame, scale: 1).resizable().scaledToFill()
        } else {
            ProgressView().tint(.white)
        }
    }
}

/// What a viewfinder says while the camera cannot run: a camera icon and `text`, and on iOS a button that opens the
/// app's page in Settings when the camera was refused. macOS has no such page to open, so it offers no button.
public struct ViewfinderMessage: View {

    // MARK: - Dependencies
    private let text: Text
    private let settingsTitle: Text?
    @Environment(\.openURL)
    private var openURL

    // MARK: - Init
    /// `settingsTitle` is the Open Settings button's title; nil for a camera that is missing rather than refused.
    public init(_ text: Text, settingsTitle: Text? = nil) {
        self.text = text
        self.settingsTitle = settingsTitle
    }

    // MARK: - Body
    public var body: some View {
        VStack(spacing: Theme.Spacing.medium) {
            Image(systemName: "camera.fill").font(.largeTitle)
            text.multilineTextAlignment(.center)
            #if os(iOS)
                if let settingsTitle, let url = URL(string: "app-settings:") {
                    Button { openURL(url) } label: { settingsTitle }
                        .buttonStyle(.borderedProminent)
                }
            #endif
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

// MARK: - Preview
#Preview("Waiting for the camera") {
    Viewfinder(frame: nil)
        .padding()
        .background(.black)
}

#Preview("Camera refused") {
    Viewfinder {
        ViewfinderMessage(Text(verbatim: "The camera is not allowed."), settingsTitle: Text(verbatim: "Open Settings"))
    }
    .padding()
    .background(.black)
}
