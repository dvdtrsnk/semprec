import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "AuthFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "AuthFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        AlldotsProject.tests(
            "AuthFeatureTests",
            for: "AuthFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
