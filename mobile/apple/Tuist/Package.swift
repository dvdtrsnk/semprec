// swift-tools-version: 6.0
import PackageDescription

#if TUIST
    import ProjectDescription
    import ProjectDescriptionHelpers

    // The packages declare lower minimums (Factory iOS 13 and macOS 10.15, NavigatorUI iOS 16 and macOS 13); they are
    // built with the app's minimums and, like every other target, for the app's architectures only.
    let packageSettings = PackageSettings(
        productTypes: ["FactoryKit": .framework, "NavigatorUI": .framework],
        baseSettings: .settings(base: [
            "ARCHS": .string(ProjectConfiguration.architectures),
            "IPHONEOS_DEPLOYMENT_TARGET": .string(ProjectConfiguration.iosMinimum),
            "MACOSX_DEPLOYMENT_TARGET": .string(ProjectConfiguration.macosMinimum),
        ])
    )
#endif

let package = Package(
    name: "SemprecDependencies",
    dependencies: [
        .package(url: "https://github.com/hmlongco/Factory", exact: "2.5.1"),
        .package(url: "https://github.com/hmlongco/Navigator", exact: "1.4.6"),
    ]
)
