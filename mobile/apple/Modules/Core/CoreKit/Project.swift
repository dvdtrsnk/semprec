import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "CoreKit",
    options: .options(automaticSchemesOptions: .disabled),
    settings: AlldotsProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        AlldotsProject.framework(
            "CoreKit",
            resources: ["Resources/**"],
            scripts: [AlldotsProject.kotlinFrameworkScript(.build)],
            settings: AlldotsProject.kotlinFrameworkScriptSettings.merging([
                "OTHER_LDFLAGS": .string("$(inherited) -framework \(ProjectConfiguration.frameworkName)"),
            ]) { _, new in new }
        ),
        AlldotsProject.tests("CoreKitTests", for: "CoreKit"),
    ],
    resourceSynthesizers: []
)
