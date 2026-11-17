import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "AccountFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "AccountFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        SemprecProject.tests(
            "AccountFeatureTests",
            for: "AccountFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
