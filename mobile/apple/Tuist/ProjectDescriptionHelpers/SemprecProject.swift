import ProjectDescription

/// Targets and settings shared by every Apple project. Each target builds natively for iOS, iPadOS and macOS
/// (not Mac Catalyst), for `ProjectConfiguration.architectures` only, because the Kotlin framework has no other
/// slices. Tuist sets the runpaths of each SDK itself (`Frameworks/` in an iOS bundle, `Contents/Frameworks/` in a
/// macOS bundle).
public enum SemprecProject {
    public static let destinations: Destinations = [.iPhone, .iPad, .mac]
    public static let deploymentTargets: DeploymentTargets = .multiplatform(
        iOS: ProjectConfiguration.iosMinimum,
        macOS: ProjectConfiguration.macosMinimum
    )

    /// Settings of a project at `Modules/<Group>/<Name>`. A module that imports CoreKit, directly or through another
    /// module, loads the Swift module of the Kotlin framework and needs its search path.
    public static func moduleSettings(loadsKotlinFramework: Bool) -> Settings {
        projectSettings(mobileRoot: "$(SRCROOT)/../../../..", loadsKotlinFramework: loadsKotlinFramework)
    }

    /// Settings of the app project at `Projects/App`.
    public static let appSettings = projectSettings(mobileRoot: "$(SRCROOT)/../../..", loadsKotlinFramework: true)

    /// A dynamic framework with its sources in `Sources/`.
    public static func framework(
        _ name: String,
        dependencies: [TargetDependency] = [],
        resources: ResourceFileElements? = nil,
        scripts: [TargetScript] = [],
        settings: SettingsDictionary = [:]
    ) -> Target {
        .target(
            name: name,
            destinations: destinations,
            product: .framework,
            bundleId: "\(ProjectConfiguration.appleBundleId).\(name)",
            deploymentTargets: deploymentTargets,
            infoPlist: .default,
            sources: ["Sources/**"],
            resources: resources,
            scripts: scripts,
            dependencies: dependencies,
            settings: .settings(base: settings)
        )
    }

    /// A unit test bundle with its sources in `Tests/`. It runs inside the app, which embeds the Kotlin framework
    /// that every module importing CoreKit loads; the host executable's path differs between iOS and macOS. Only the
    /// app's own tests link against the app executable (`BUNDLE_LOADER`). A module's tests link only the module: its
    /// project has no dependency on the app, so they may link before the app is built.
    public static func tests(_ name: String, for target: String, dependencies: [TargetDependency] = []) -> Target {
        .target(
            name: name,
            destinations: destinations,
            product: .unitTests,
            bundleId: "\(ProjectConfiguration.appleBundleId).\(name)",
            deploymentTargets: deploymentTargets,
            infoPlist: .default,
            sources: ["Tests/**"],
            dependencies: [.target(name: target)] + dependencies,
            settings: .settings(base: appHost(linksAgainstApp: target == ProjectConfiguration.appName))
        )
    }
}

// MARK: - Kotlin framework
extension SemprecProject {
    /// What a target's `mobile/scripts/kmp-framework` phase does with the Kotlin framework.
    public enum KotlinFrameworkPhase: String {
        /// Builds the framework for the current SDK and configuration into
        /// `mobile/shared/umbrella/build/xcode-frameworks/`, the search path of every target that loads it.
        case build = "--build-only"
        /// Copies the framework into the app bundle and signs it when signing is allowed.
        case embed = "--embed"
    }

    /// A phase that runs Gradle before the target compiles. Gradle decides itself whether the framework is up to
    /// date, so the phase runs on every build.
    public static func kotlinFrameworkScript(_ phase: KotlinFrameworkPhase) -> TargetScript {
        .pre(
            script: "\"$MOBILE_ROOT/scripts/kmp-framework\" \(phase.rawValue)",
            name: phase == .build ? "Build the Kotlin framework" : "Embed the Kotlin framework",
            basedOnDependencyAnalysis: false
        )
    }

    /// Settings of a target with a `kotlinFrameworkScript` phase: Gradle reads and writes the whole Gradle build,
    /// which a sandboxed script cannot.
    public static let kotlinFrameworkScriptSettings: SettingsDictionary = ["ENABLE_USER_SCRIPT_SANDBOXING": "NO"]
}

// MARK: - Private
extension SemprecProject {
    private static func projectSettings(mobileRoot: String, loadsKotlinFramework: Bool) -> Settings {
        var base: SettingsDictionary = [
            "MOBILE_ROOT": .string(mobileRoot),
            "SWIFT_VERSION": "6.0",
            "SWIFT_STRICT_CONCURRENCY": "complete",
            "ARCHS": .string(ProjectConfiguration.architectures),
            "MARKETING_VERSION": .string(ProjectConfiguration.versionName),
            "CURRENT_PROJECT_VERSION": .string(ProjectConfiguration.versionCode),
            "ENABLE_USER_SCRIPT_SANDBOXING": "YES",
        ]
        if loadsKotlinFramework {
            base["FRAMEWORK_SEARCH_PATHS"] = [
                "$(inherited)",
                "$(MOBILE_ROOT)/shared/umbrella/build/xcode-frameworks/$(CONFIGURATION)/$(SDK_NAME)",
            ]
        }
        return .settings(base: base, configurations: [.debug(name: .debug), .release(name: .release)])
    }

    private static func appHost(linksAgainstApp: Bool) -> SettingsDictionary {
        let app = ProjectConfiguration.appName
        return [
            "TEST_HOST": .string("$(BUILT_PRODUCTS_DIR)/\(app).app/\(app)"),
            "TEST_HOST[sdk=macosx*]": .string("$(BUILT_PRODUCTS_DIR)/\(app).app/Contents/MacOS/\(app)"),
            "BUNDLE_LOADER": linksAgainstApp ? "$(TEST_HOST)" : "",
        ]
    }
}
