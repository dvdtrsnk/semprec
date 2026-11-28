import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "TasksFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "TasksFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
                .project(target: "NoteEditor", path: "../../Core/NoteEditor"),
            ],
            resources: ["Resources/**"]
        ),
        AlldotsProject.tests(
            "TasksFeatureTests",
            for: "TasksFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
