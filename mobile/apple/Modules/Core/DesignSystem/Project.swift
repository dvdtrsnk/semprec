import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "DesignSystem",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: false),
    targets: [SemprecProject.framework("DesignSystem", resources: ["Resources/**"])],
    resourceSynthesizers: []
)
