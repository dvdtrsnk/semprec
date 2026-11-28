import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "NoteEditor",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "NoteEditor",
            dependencies: [
                .project(target: "CoreKit", path: "../CoreKit"),
                .project(target: "DesignSystem", path: "../DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        AlldotsProject.tests(
            "NoteEditorTests",
            for: "NoteEditor",
            dependencies: [.project(target: "CoreKit", path: "../CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
