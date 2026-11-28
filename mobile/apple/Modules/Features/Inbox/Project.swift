import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "InboxFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "InboxFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
                .project(target: "NoteEditor", path: "../../Core/NoteEditor"),
            ],
            resources: ["Resources/**"]
        ),
        AlldotsProject.tests(
            "InboxFeatureTests",
            for: "InboxFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
