import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "SempFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "SempFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        AlldotsProject.tests(
            "SempFeatureTests",
            for: "SempFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
