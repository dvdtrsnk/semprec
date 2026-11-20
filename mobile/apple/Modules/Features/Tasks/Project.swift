import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "TasksFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "TasksFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
                .project(target: "NoteEditor", path: "../../Core/NoteEditor"),
            ],
            resources: ["Resources/**"]
        ),
        SemprecProject.tests(
            "TasksFeatureTests",
            for: "TasksFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
