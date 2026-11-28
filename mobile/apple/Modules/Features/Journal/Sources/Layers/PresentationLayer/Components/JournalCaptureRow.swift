import CoreKit
import DesignSystem
import PDFKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The row under today's Inbox items that writes something down into the Inbox: a type picked from a menu, a text,
/// and a photo, a file or, on an iPhone or iPad with the document scanner, a scanned document. The text stays in this
/// view until it is sent; a capture that went through clears it.
struct JournalCaptureRow: View {

    // MARK: - Dependencies
    @ObservedObject var viewModel: JournalCaptureViewModel
    /// The day the capture is written on, `YYYY-MM-DD`.
    let day: String

    // MARK: - State
    @State private var draft = ""
    @State private var choosingPhoto = false
    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var scanning = false
    /// A picked photo or file whose bytes could not be read, or a scan that could not be kept.
    @State private var unreadable = false

    // MARK: - Body
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.small) {
            if let attachment = viewModel.state.attachment {
                attachmentChip(attachment)
            }
            HStack(spacing: Theme.Spacing.small) {
                typeMenu
                TextField(text: $draft) { Text("journal.capture.placeholder", bundle: .module) }
                    .submitLabel(.send)
                    .onSubmit(send)
                    .disabled(viewModel.state.sending)
                    .accessibilityIdentifier(JournalIdentifiers.captureText)
                attachMenu
                if viewModel.state.sending {
                    ProgressView()
                } else if canSend {
                    Button(action: send) {
                        Label { Text("journal.capture.send", bundle: .module) } icon: {
                            Image(systemName: "arrow.up.circle.fill")
                        }
                    }
                    .labelStyle(.iconOnly)
                    .font(.title2)
                    .accessibilityIdentifier(JournalIdentifiers.captureSend)
                }
            }
        }
        .photosPicker(isPresented: $choosingPhoto, selection: $photo, matching: .images)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in pickFile(result) }
        .documentScanner(isPresented: $scanning, onFinish: attachScan) { unreadable = true }
        .onChange(of: photo) { _, item in pickPhoto(item) }
        .onChange(of: viewModel.captured) { _, _ in draft = "" }
        .alert(
            Text("journal.capture.failed", bundle: .module),
            isPresented: failureShown,
            presenting: viewModel.state.failure
        ) { _ in
            Button(role: .cancel, action: viewModel.dismissFailure) { Text("journal.problem.dismiss", bundle: .module) }
        } message: { failure in
            Text(FailureKind.message(for: failure.kind))
        }
        .alert(Text("journal.capture.failed", bundle: .module), isPresented: $unreadable) {
            Button(role: .cancel) {} label: { Text("journal.problem.dismiss", bundle: .module) }
        } message: {
            Text(FailureKind.message(for: .invalidData))
        }
        .task { viewModel.loadTypes() }
        .task { await viewModel.observe() }
    }
}

// MARK: - Subviews
private extension JournalCaptureRow {

    var typeMenu: some View {
        Menu {
            Picker(selection: Binding(get: { viewModel.state.typeId }, set: { viewModel.pickType($0) })) {
                Text("journal.capture.noType", bundle: .module).tag(String?.none)
                ForEach(viewModel.state.types) { type in
                    Text(verbatim: "\(type.emoji) \(type.label)").tag(String?.some(type.id))
                }
            } label: {
                Text("journal.capture.type", bundle: .module)
            }
            .pickerStyle(.inline)
        } label: {
            if let emoji = pickedType?.emoji {
                Text(verbatim: emoji)
            } else {
                Image(systemName: "tray")
            }
        }
        .accessibilityLabel(Text("journal.capture.type", bundle: .module))
        .accessibilityValue(Text(verbatim: pickedType?.label ?? ""))
        .accessibilityIdentifier(JournalIdentifiers.captureType)
    }

    var attachMenu: some View {
        Menu {
            Button { choosingPhoto = true } label: {
                Label { Text("journal.capture.photo", bundle: .module) } icon: { Image(systemName: "photo") }
            }
            Button { importing = true } label: {
                Label { Text("journal.capture.file", bundle: .module) } icon: { Image(systemName: "doc") }
            }
            if ScanDocument.isScannerSupported {
                Button { scanning = true } label: {
                    Label { Text("journal.capture.scan", bundle: .module) } icon: {
                        Image(systemName: "doc.viewfinder")
                    }
                }
                .accessibilityIdentifier(JournalIdentifiers.captureScan)
            }
        } label: {
            Label { Text("journal.capture.attach", bundle: .module) } icon: { Image(systemName: "paperclip") }
        }
        .labelStyle(.iconOnly)
        .disabled(viewModel.state.sending)
        .accessibilityIdentifier(JournalIdentifiers.captureAttach)
    }

    func attachmentChip(_ attachment: InboxCaptureAttachment) -> some View {
        HStack(spacing: Theme.Spacing.small) {
            Label {
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: attachment.filename).lineLimit(1)
                    Text(Int64(attachment.byteSize), format: .byteCount(style: .file))
                        .font(.footnote)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            } icon: {
                Image(systemName: attachment.mimeType.hasPrefix("image/") ? "photo" : "doc")
            }
            Spacer(minLength: 0)
            Button(action: viewModel.removeAttachment) {
                Label { Text("journal.capture.remove", bundle: .module) } icon: {
                    Image(systemName: "xmark.circle.fill")
                }
            }
            .labelStyle(.iconOnly)
            .foregroundStyle(Theme.Colors.secondaryText)
            .accessibilityIdentifier(JournalIdentifiers.captureRemove)
        }
    }

    var pickedType: InboxCaptureType? {
        viewModel.state.types.first { $0.id == viewModel.state.typeId }
    }

    var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || viewModel.state.attachment != nil
    }

    var failureShown: Binding<Bool> {
        Binding(get: { viewModel.state.failure != nil }, set: { if !$0 { viewModel.dismissFailure() } })
    }
}

// MARK: - Actions
private extension JournalCaptureRow {

    func send() {
        guard canSend, !viewModel.state.sending else { return }
        viewModel.submit(text: draft, day: day, time: ClockTime.string(from: .now))
    }

    func pickPhoto(_ item: PhotosPickerItem?) {
        guard let item else { return }
        photo = nil
        let name = String(
            format: String(localized: "journal.capture.photoName", bundle: .module),
            ClockTime.string(from: .now)
        )
        Task {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    unreadable = true
                    return
                }
                let type = item.supportedContentTypes.first { $0.conforms(to: .image) }
                viewModel.attach(CaptureFile.photo(data, type: type, named: name), source: .photoLibrary)
            } catch {
                unreadable = true
            }
        }
    }

    func attachScan(_ pages: [PDFPage]) {
        if !viewModel.attachScan(pages, scannedAt: .now) { unreadable = true }
    }

    func pickFile(_ result: Result<URL, Error>) {
        // A cancelled picker answers with no URL and nothing to report.
        guard case .success(let url) = result else { return }
        Task {
            do {
                let file = try await Task.detached(operation: { try CaptureFile.read(url) }).value
                viewModel.attach(file, source: .files)
            } catch {
                unreadable = true
            }
        }
    }
}
