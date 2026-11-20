import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "NoteEditor",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "NoteEditor",
            dependencies: [
                .project(target: "CoreKit", path: "../CoreKit"),
                .project(target: "DesignSystem", path: "../DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        SemprecProject.tests(
            "NoteEditorTests",
            for: "NoteEditor",
            dependencies: [.project(target: "CoreKit", path: "../CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
