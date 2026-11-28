import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "DesignSystem",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: false),
    targets: [
        AlldotsProject.framework("DesignSystem", resources: ["Resources/**"]),
        AlldotsProject.tests("DesignSystemTests", for: "DesignSystem"),
    ],
    resourceSynthesizers: []
)
