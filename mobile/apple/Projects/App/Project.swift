import ProjectDescription
import ProjectDescriptionHelpers

let app = ProjectConfiguration.appName

let project = Project(
    name: "App",
    options: .options(automaticSchemesOptions: .disabled),
    settings: SemprecProject.appSettings,
    targets: [
        .target(
            name: app,
            destinations: SemprecProject.destinations,
            product: .app,
            bundleId: ProjectConfiguration.appleBundleId,
            deploymentTargets: SemprecProject.deploymentTargets,
            // Tuist's default app plist mixes iOS and macOS keys (a Main storyboard, an armv7 requirement), so the
            // app lists its keys itself. macOS ignores the UIKit keys; Xcode adds the platform keys of each SDK.
            infoPlist: .dictionary([
                "CFBundleDevelopmentRegion": "en",
                "CFBundleDisplayName": .string(app),
                "CFBundleExecutable": "$(EXECUTABLE_NAME)",
                "CFBundleIdentifier": "$(PRODUCT_BUNDLE_IDENTIFIER)",
                "CFBundleInfoDictionaryVersion": "6.0",
                "CFBundleLocalizations": ["en", "cs"],
                "CFBundleName": "$(PRODUCT_NAME)",
                "CFBundlePackageType": "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
                "CFBundleShortVersionString": "$(MARKETING_VERSION)",
                "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
                "LSApplicationCategoryType": "public.app-category.productivity",
                "UIApplicationSceneManifest": ["UIApplicationSupportsMultipleScenes": true],
                "UILaunchScreen": [:],
                "UISupportedInterfaceOrientations": [
                    "UIInterfaceOrientationPortrait",
                    "UIInterfaceOrientationLandscapeLeft",
                    "UIInterfaceOrientationLandscapeRight",
                ],
                "UISupportedInterfaceOrientations~ipad": [
                    "UIInterfaceOrientationPortrait",
                    "UIInterfaceOrientationPortraitUpsideDown",
                    "UIInterfaceOrientationLandscapeLeft",
                    "UIInterfaceOrientationLandscapeRight",
                ],
            ]),
            sources: ["Sources/**"],
            resources: ["Resources/**"],
            scripts: [SemprecProject.kotlinFrameworkScript(.embed)],
            dependencies: [
                .project(target: "CoreKit", path: "../../Modules/Core/CoreKit"),
                .project(target: "Dependencies", path: "../../Modules/Core/Dependencies"),
                .project(target: "HomeFeature", path: "../../Modules/Features/Home"),
                .project(target: "SettingsFeature", path: "../../Modules/Features/Settings"),
                .external(name: "NavigatorUI"),
            ],
            settings: .settings(
                base: SemprecProject.kotlinFrameworkScriptSettings
                    .merging(["CODE_SIGN_ENTITLEMENTS[sdk=macosx*]": "Entitlements/\(app).entitlements"]) { _, new in new }
            )
        ),
        // The app's tests drive its NavigatorUI stacks directly.
        SemprecProject.tests("\(app)Tests", for: app, dependencies: [.external(name: "NavigatorUI")]),
        // XCUITest drives the app from outside, by the accessibility identifiers the app and the features declare; it
        // compiles their identifier files, since it links none of their modules. iPhone and iPad only: on macOS
        // XCUITest needs the Accessibility permission to control the app, which a build machine does not grant.
        .target(
            name: "\(app)UITests",
            destinations: [.iPhone, .iPad],
            product: .uiTests,
            bundleId: "\(ProjectConfiguration.appleBundleId).\(app)UITests",
            deploymentTargets: .iOS(ProjectConfiguration.iosMinimum),
            // The bundle carries the app's version and build, which the About sheet shows.
            infoPlist: .extendingDefault(with: [
                "CFBundleShortVersionString": "$(MARKETING_VERSION)",
                "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
            ]),
            sources: [
                "UITests/**",
                "Sources/AppIdentifiers.swift",
                "../../Modules/Features/Home/Sources/HomeIdentifiers.swift",
                "../../Modules/Features/Settings/Sources/SettingsIdentifiers.swift",
            ],
            dependencies: [.target(name: app)]
        ),
    ],
    additionalFiles: ["Entitlements/**"],
    resourceSynthesizers: []
)
