import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "NotesFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "NotesFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "NoteEditor", path: "../../Core/NoteEditor"),
            ]
        ),
        AlldotsProject.tests(
            "NotesFeatureTests",
            for: "NotesFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
