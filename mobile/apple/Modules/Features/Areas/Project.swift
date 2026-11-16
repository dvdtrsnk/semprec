import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "AreasFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "AreasFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        SemprecProject.tests(
            "AreasFeatureTests",
            for: "AreasFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
