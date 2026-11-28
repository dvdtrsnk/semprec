import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "SleepFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "SleepFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        AlldotsProject.tests(
            "SleepFeatureTests",
            for: "SleepFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
