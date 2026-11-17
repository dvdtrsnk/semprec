import ProjectDescription
import ProjectDescriptionHelpers

let project = Project(
    name: "CoreKit",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.moduleSettings(loadsKotlinFramework: true),
    targets: [
        SemprecProject.framework(
            "CoreKit",
            scripts: [SemprecProject.kotlinFrameworkScript(.build)],
            settings: SemprecProject.kotlinFrameworkScriptSettings.merging([
                "OTHER_LDFLAGS": .string("$(inherited) -framework \(ProjectConfiguration.frameworkName)"),
            ]) { _, new in new }
        ),
        SemprecProject.tests("CoreKitTests", for: "CoreKit"),
    ]
)
