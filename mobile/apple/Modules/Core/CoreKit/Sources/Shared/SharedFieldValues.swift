@preconcurrency internal import SharedSDK

// MARK: - Shared fields
extension FieldOption {

    init(_ option: SharedSDK.OptionView) {
        self.init(key: option.key, label: option.label, color: option.color)
    }
}

extension FieldTarget {

    init(_ target: SharedSDK.TargetView) {
        self.init(id: target.id, databaseKey: target.databaseKey, title: target.title, color: target.color)
    }
}

extension FieldKind {

    init(_ kind: SharedSDK.FieldKind) {
        switch kind {
        case .text: self = .text
        case .longText: self = .longText
        case .number: self = .number
        case .select: self = .select
        case .multiSelect: self = .multiSelect
        case .date: self = .date
        case .time: self = .time
        case .checkbox: self = .checkbox
        case .relation: self = .relation
        case .file: self = .file
        case .url: self = .url
        }
    }
}

extension FieldContent {

    init(_ content: any SharedSDK.FieldContent) {
        switch onEnum(of: content) {
        case .empty: self = .empty
        case .text(let text): self = .text(text.text)
        case .number(let number): self = .number(number.number)
        case .flag(let flag): self = .flag(flag.on)
        case .day(let day): self = .day(day.iso)
        case .clock(let clock): self = .clock(clock.time)
        case .link(let link): self = .link(link.url)
        case .choices(let choices): self = .choices(choices.options.map(FieldOption.init))
        case .targets(let targets): self = .targets(targets.targets.map(FieldTarget.init))
        case .blob(let blob):
            self = .blob(blobId: blob.blobId, filename: blob.filename, mimeType: blob.mimeType, byteSize: blob.byteSize)
        }
    }
}

extension ValueOrigin {

    init(_ origin: SharedSDK.OriginView) {
        let kind: OriginKind
        switch origin.kind {
        case .inherited: kind = .inherited
        case .inheritedBroken: kind = .inheritedBroken
        case .derived: kind = .derived
        }
        let author: OriginAuthor? = origin.brokenBy.map { author in
            switch author {
            case .user: .user
            case .agent: .agent
            }
        }
        self.init(
            kind: kind,
            sources: origin.sources.map { OriginSource(itemId: $0.itemId, databaseKey: $0.databaseKey, title: $0.title) },
            brokenBy: author
        )
    }
}

extension FieldView {

    init(_ view: SharedSDK.FieldView) {
        self.init(
            propertyKey: view.propertyKey,
            name: view.name,
            kind: FieldKind(view.kind),
            content: FieldContent(view.content),
            options: view.options.map(FieldOption.init),
            editable: view.editable,
            origin: view.origin.map(ValueOrigin.init)
        )
    }
}

extension Failed {

    init(_ failed: SharedSDK.Failed) {
        self.init(kind: failed.kind.map(FailureKind.init))
    }
}
