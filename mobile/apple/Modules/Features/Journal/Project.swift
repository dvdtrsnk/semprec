import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "JournalFeature",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "JournalFeature",
            dependencies: [
                .project(target: "CoreKit", path: "../../Core/CoreKit"),
                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),
            ],
            resources: ["Resources/**"]
        ),
        SemprecProject.tests(
            "JournalFeatureTests",
            for: "JournalFeature",
            dependencies: [.project(target: "CoreKit", path: "../../Core/CoreKit")]
        ),
    ],
    resourceSynthesizers: []
)
