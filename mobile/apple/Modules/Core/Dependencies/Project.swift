import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "Dependencies",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "Dependencies",
            dependencies: [
                .project(target: "CoreKit", path: "../CoreKit"),
                .external(name: "FactoryKit"),
            ]
        ),
    ]
)
