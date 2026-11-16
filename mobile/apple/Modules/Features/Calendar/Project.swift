import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "CalendarFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "CalendarFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        SemprecProject.tests(
            "CalendarFeatureTests",
            for: "CalendarFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
