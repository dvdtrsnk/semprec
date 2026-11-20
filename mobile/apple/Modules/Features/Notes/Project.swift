import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "NotesFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "NotesFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "NoteEditor", path: "../../Core/NoteEditor"),
            ]
        ),
        SemprecProject.tests(
            "NotesFeatureTests",
            for: "NotesFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
