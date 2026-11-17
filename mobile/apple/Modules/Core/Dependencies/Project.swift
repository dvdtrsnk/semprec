import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "Dependencies",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "Dependencies",
            dependencies: [
                .project(target: "CoreKit", path: "../CoreKit"),
                .external(name: "FactoryKit"),
            ]
        ),
    ]
)
