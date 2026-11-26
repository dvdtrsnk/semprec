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
                // The scheme a browser sign-in returns to (`semprec://oauth`), caught by the sign-in's own session;
                // the app reads no URL it is opened with.
                "CFBundleURLTypes": [
                    [
                        "CFBundleURLName": "$(PRODUCT_BUNDLE_IDENTIFIER).oauth",
                        "CFBundleURLSchemes": ["semprec"],
                    ],
                ],
                "CFBundleVersion": "$(CURRENT_PROJECT_VERSION)",
                "LSApplicationCategoryType": "public.app-category.productivity",
                // AlarmKit asks for this when the first sleep alarm is scheduled; macOS has no AlarmKit and ignores it.
                "NSAlarmKitUsageDescription": "Semprec rings your alarms even in silent mode and through a Focus.",
                "NSMicrophoneUsageDescription": "Semprec records meetings and voice notes so that Semp can transcribe them.",
                "UIApplicationSceneManifest": ["UIApplicationSupportsMultipleScenes": true],
                // `remote-notification` lets a silent push wake the app to read its reminders again.
                "UIBackgroundModes": ["audio", "remote-notification"],
                // The APNs environment the device token is registered for, by build configuration.
                "SemprecApnsEnvironment": "$(SEMPREC_APNS_ENVIRONMENT)",
                "UILaunchScreen": [:],
                // The type a drag of a calendar item carries within the app and between its windows; other apps take
                // the iCalendar and plain-text forms the same drag also offers.
                "UTExportedTypeDeclarations": [
                    [
                        "UTTypeIdentifier": "cz.semprec.calendar-item",
                        "UTTypeDescription": "Semprec calendar item",
                        "UTTypeConformsTo": ["public.data"],
                    ],
                ],
                "SemprecDefaultServer": .string(ProjectConfiguration.defaultServer),
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
                .project(target: "DesignSystem", path: "../../Modules/Core/DesignSystem"),
                .project(target: "AccountFeature", path: "../../Modules/Features/Account"),
                .project(target: "AreasFeature", path: "../../Modules/Features/Areas"),
                .project(target: "AuthFeature", path: "../../Modules/Features/Auth"),
                .project(target: "CalendarFeature", path: "../../Modules/Features/Calendar"),
                .project(target: "CollectionsFeature", path: "../../Modules/Features/Collections"),
                .project(target: "JournalFeature", path: "../../Modules/Features/Journal"),
                .project(target: "NotesFeature", path: "../../Modules/Features/Notes"),
                .project(target: "MailFeature", path: "../../Modules/Features/Mail"),
                .project(target: "OverviewFeature", path: "../../Modules/Features/Overview"),
                .project(target: "SempFeature", path: "../../Modules/Features/Semp"),
                .project(target: "RecordingsFeature", path: "../../Modules/Features/Recordings"),
                .project(target: "SleepFeature", path: "../../Modules/Features/Sleep"),
                .project(target: "InboxFeature", path: "../../Modules/Features/Inbox"),
                .project(target: "TasksFeature", path: "../../Modules/Features/Tasks"),
                .external(name: "NavigatorUI"),
            ],
            // A Debug build is signed for the APNs sandbox, a Release build (App Store, TestFlight, Ad Hoc) for
            // production; `aps-environment` of the iOS entitlements and `SemprecApnsEnvironment` follow it.
            settings: .settings(
                base: SemprecProject.kotlinFrameworkScriptSettings
                    .merging([
                        "CODE_SIGN_ENTITLEMENTS[sdk=macosx*]": "Entitlements/\(app).entitlements",
                        "CODE_SIGN_ENTITLEMENTS[sdk=iphone*]": "Entitlements/\(app)-iOS.entitlements",
                    ]) { _, new in new },
                configurations: [
                    .debug(
                        name: .debug,
                        settings: ["SEMPREC_APS_ENVIRONMENT": "development", "SEMPREC_APNS_ENVIRONMENT": "sandbox"]
                    ),
                    .release(
                        name: .release,
                        settings: ["SEMPREC_APS_ENVIRONMENT": "production", "SEMPREC_APNS_ENVIRONMENT": "production"]
                    ),
                ]
            )
        ),
        // The app's tests drive its NavigatorUI stacks directly.
        SemprecProject.tests(
            "\(app)Tests",
            for: app,
            dependencies: [
                .project(target: "CoreKit", path: "../../Modules/Core/CoreKit"),
                .project(target: "OverviewFeature", path: "../../Modules/Features/Overview"),
                .external(name: "NavigatorUI"),
            ]
        ),
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
            ],
            dependencies: [.target(name: app)]
        ),
    ],
    additionalFiles: ["Entitlements/**"],
    resourceSynthesizers: []
)
