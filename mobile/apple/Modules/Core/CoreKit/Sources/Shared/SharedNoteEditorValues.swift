@preconcurrency internal import SharedSDK

// MARK: - NoteEditorBlockType
extension NoteEditorBlockType {

    init(_ type: SharedSDK.NoteEditorBlockType) {
        switch type {
        case .text: self = .text
        case .h1: self = .h1
        case .h2: self = .h2
        case .h3: self = .h3
        case .bullet: self = .bullet
        case .number: self = .number
        case .todo: self = .todo
        case .quote: self = .quote
        case .page: self = .page
        }
    }

    var shared: SharedSDK.NoteEditorBlockType {
        switch self {
        case .text: .text
        case .h1: .h1
        case .h2: .h2
        case .h3: .h3
        case .bullet: .bullet
        case .number: .number
        case .todo: .todo
        case .quote: .quote
        case .page: .page
        }
    }
}

// MARK: - NoteEditorMark
extension NoteEditorMark {

    init(_ mark: SharedSDK.NoteEditorMark) {
        switch mark {
        case .bold: self = .bold
        case .italic: self = .italic
        case .code: self = .code
        }
    }

    var shared: SharedSDK.NoteEditorMark {
        switch self {
        case .bold: .bold
        case .italic: .italic
        case .code: .code
        }
    }
}

// MARK: - NoteEditorRun
extension NoteEditorRun {

    init(_ run: SharedSDK.NoteEditorRun) {
        self.init(run.text, bold: run.bold, italic: run.italic, code: run.code, link: run.link)
    }

    var shared: SharedSDK.NoteEditorRun {
        SharedSDK.NoteEditorRun(text: text, bold: bold, italic: italic, code: code, link: link)
    }
}

// MARK: - NoteEditorBlock
extension NoteEditorBlock {

    init(_ block: SharedSDK.NoteEditorBlock) {
        self.init(
            id: block.id,
            type: NoteEditorBlockType(block.type),
            indent: Int(block.indent),
            done: block.done,
            runs: block.runs.map(NoteEditorRun.init),
            pageId: block.pageId,
            marker: block.marker.map(NoteEditorMarker.init)
        )
    }
}

// MARK: - NoteEditorMarker
extension NoteEditorMarker {

    init(_ marker: any SharedSDK.NoteEditorMarker) {
        switch onEnum(of: marker) {
        case .bullet(let bullet): self = .bullet(level: Int(bullet.level))
        case .number(let number): self = .number(number.label)
        }
    }
}

// MARK: - NoteEditorPhase
extension NoteEditorPhase {

    init(_ phase: SharedSDK.NoteEditorPhase, failure: SharedSDK.FailureKind?) {
        switch phase {
        case .loading: self = .loading
        case .content: self = .content
        case .error: self = .failure(failure.map(FailureKind.init))
        }
    }
}

// MARK: - NoteEditorProblem
extension NoteEditorProblem {

    /// `nil` when nothing needs telling.
    init?(_ problem: SharedSDK.NoteEditorProblem?, failure: SharedSDK.FailureKind?) {
        switch problem {
        case .none: return nil
        case .some(.reloaded): self = .reloaded
        case .some(.failed): self = .failed(failure.map(FailureKind.init))
        }
    }
}
