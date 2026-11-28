import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "JournalFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "JournalFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
                .project(target: "NoteEditor", path: "../../Core/NoteEditor"),
            ],
            resources: ["Resources/**"]
        ),
        AlldotsProject.tests(
            "JournalFeatureTests",
            for: "JournalFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
