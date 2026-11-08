/**
 * Tests of architecture.mjs: every rule passes on the real mobile tree, and every rule fails on a copy of that
 * tree with one violation added. Each copy leaves out build outputs (the same directories the check ignores);
 * each edit asserts that it changed the file, so a test whose edit no longer applies fails instead of passing.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { POLICY_FILE, RULES, checkArchitecture, isIgnoredName } from "./architecture.mjs";

const SCRIPT = fileURLToPath(new URL("./architecture.mjs", import.meta.url));
const MOBILE = path.resolve(path.dirname(SCRIPT), "..");

const KOTLIN = "kotlin/cz/semprec/app";
const PRESENTATION = `shared/presentation/src/commonMain/${KOTLIN}/presentation`;
const HOME_FEATURE = `android/feature/home/src/main/${KOTLIN}/feature/home/presentation/screen`;
const HOME_MODULE = "apple/Modules/Features/Home";
const HOME_SWIFT_SCREENS = `${HOME_MODULE}/Sources/Layers/PresentationLayer/Screens`;
const HOME_SCREEN_SWIFT = `${HOME_SWIFT_SCREENS}/HomeScreen/HomeScreen.swift`;
const COREKIT_SHARED = "apple/Modules/Core/CoreKit/Sources/Shared";
const PROJECT_CONFIGURATION = "apple/Tuist/ProjectDescriptionHelpers/ProjectConfiguration.swift";
const HOME_CATALOG = `${HOME_MODULE}/Resources/Localizable.xcstrings`;
const SETTINGS_CATALOG = "apple/Modules/Features/Settings/Resources/Localizable.xcstrings";
const APP_CATALOG = "apple/Projects/App/Resources/Localizable.xcstrings";
const APP_MANIFEST = "apple/Projects/App/Project.swift";
const UI_TESTS = "apple/Projects/App/UITests";

/** An abstract screen ViewModel between ScreenViewModel and the concrete ones. */
const LIST_VIEW_MODEL = "package cz.semprec.app.presentation\n\nabstract class ListViewModel : ScreenViewModel<SettingsState, SettingsAction, SettingsEffect>(SettingsState())\n";

const temporaryDirectories = [];
after(() => {
  for (const dir of temporaryDirectories) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the real mobile tree, without build outputs, to break a rule in. */
function copyOfTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "mobile-architecture-"));
  temporaryDirectories.push(dir);
  const root = path.join(dir, "mobile");
  cpSync(MOBILE, root, { recursive: true, filter: (source) => !isIgnoredName(path.basename(source)) });
  return root;
}

function replace(root, file, from, to) {
  const target = path.join(root, file);
  const text = readFileSync(target, "utf8");
  assert.ok(text.includes(from), `${file} no longer contains ${JSON.stringify(from)}; update this test`);
  writeFileSync(target, text.replace(from, to));
}

function append(root, file, text) {
  const target = path.join(root, file);
  writeFileSync(target, readFileSync(target, "utf8") + text);
}

function write(root, file, text) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function remove(root, file) {
  const target = path.join(root, file);
  assert.ok(existsSync(target), `${file} no longer exists; update this test`);
  rmSync(target);
}

function editJson(root, file, change) {
  const target = path.join(root, file);
  const value = JSON.parse(readFileSync(target, "utf8"));
  change(value);
  writeFileSync(target, JSON.stringify(value, null, 2));
}

const editPolicy = (root, change) => editJson(root, POLICY_FILE, change);

/** Asserts that exactly `rules` are violated and that each pattern matches one violation message. */
function assertViolations(root, rules, ...patterns) {
  const violations = checkArchitecture(root);
  const shown = violations.map((v) => `${v.rule} ${v.file}:${v.line ?? "-"} ${v.message}`).join("\n");
  assert.deepEqual([...new Set(violations.map((v) => v.rule))].sort(), [...rules].sort(), shown);
  for (const pattern of patterns) assert.ok(violations.some((v) => pattern.test(v.message)), `no violation matches ${pattern}:\n${shown}`);
  return violations;
}

function run(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

/**
 * Runs `<link>/<script>` with no argument, where `<link>` is a fresh symbolic link to `directory`, so the script's
 * path goes through the link (as it does below /tmp on macOS); the link alone is removed afterwards.
 */
function runThroughSymlink(directory, script) {
  const dir = mkdtempSync(path.join(tmpdir(), "mobile-architecture-link-"));
  temporaryDirectories.push(dir);
  const link = path.join(dir, "link");
  symlinkSync(directory, link, "dir");
  try {
    const result = spawnSync(process.execPath, [path.join(link, script)], { encoding: "utf8", cwd: tmpdir() });
    return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
  } finally {
    unlinkSync(link);
  }
}

describe("the real tree", () => {
  let violations;
  const real = () => (violations ??= checkArchitecture(MOBILE));
  for (const { id } of RULES) {
    it(`passes ${id}`, () => assert.deepEqual(real().filter((v) => v.rule === id), []));
  }

  it("passes on the command line, from any working directory", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", cwd: tmpdir() });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const { id } of RULES) assert.match(result.stdout, new RegExp(`^ok   ${id} `, "m"));
    assert.match(result.stdout, /all 10 rules passed/);
  });

  it("passes on the command line through a symlinked path", () => {
    const { status, stdout, output } = runThroughSymlink(MOBILE, "scripts/architecture.mjs");
    assert.equal(status, 0, output);
    for (const { id } of RULES) assert.match(stdout, new RegExp(`^ok   ${id} `, "m"));
    assert.match(stdout, /all 10 rules passed/);
  });
});

describe("ARCH-GRADLE", () => {
  it("fails a project dependency the policy does not allow", () => {
    const root = copyOfTree();
    replace(root, "shared/presentation/build.gradle.kts", 'implementation(project(":shared:domain"))', 'implementation(project(":shared:domain"))\n            implementation(project(":shared:data"))');
    const [found] = assertViolations(root, ["ARCH-GRADLE"], /:shared:presentation depends on :shared:data/);
    assert.equal(found.file, "shared/presentation/build.gradle.kts");
    assert.equal(found.line, 7);
  });

  it("fails an included module without a policy entry, and does not check its dependencies", () => {
    const root = copyOfTree();
    append(root, "settings.gradle.kts", 'include(":android:feature:profile")\n');
    write(root, "android/feature/profile/build.gradle.kts", 'dependencies { implementation(project(":shared:data")) }\n');
    const violations = assertViolations(root, ["ARCH-GRADLE"], /includes :android:feature:profile, which has no entry/);
    assert.equal(violations.length, 1);
  });

  it("fails a policy entry for a module settings.gradle.kts does not include", () => {
    const root = copyOfTree();
    editPolicy(root, (policy) => (policy.gradle.modules[":android:feature:profile"] = [":android:core:ui"]));
    assertViolations(root, ["ARCH-GRADLE"], /lists :android:feature:profile, which settings.gradle.kts does not include/);
  });

  it("fails a cycle even when the policy allows every edge of it", () => {
    const root = copyOfTree();
    replace(root, "shared/domain/build.gradle.kts", 'api(project(":shared:core"))', 'api(project(":shared:core"))\n            implementation(project(":shared:presentation"))');
    editPolicy(root, (policy) => policy.gradle.modules[":shared:domain"].push(":shared:presentation"));
    assertViolations(root, ["ARCH-GRADLE"], /dependency cycle :shared:domain -> :shared:presentation -> :shared:domain/);
  });
});

describe("ARCH-APPLE", () => {
  it("fails an import of a module the policy does not allow, which the manifest does not declare either", () => {
    const root = copyOfTree();
    replace(root, HOME_SCREEN_SWIFT, "import DesignSystem\n", "import DesignSystem\nimport SettingsFeature\n");
    const violations = assertViolations(root, ["ARCH-APPLE"], /HomeFeature imports SettingsFeature, which .*allowed does not list/, /HomeFeature imports SettingsFeature without declaring it/);
    assert.ok(violations.every((v) => v.file === HOME_SCREEN_SWIFT && v.line === 3));
  });

  it("fails an import the policy allows but the manifest does not declare", () => {
    const root = copyOfTree();
    replace(root, `${HOME_MODULE}/Project.swift`, '                .project(target: "DesignSystem", path: "../../Core/DesignSystem"),\n', "");
    const violations = assertViolations(root, ["ARCH-APPLE"], /HomeFeature imports DesignSystem without declaring it as a dependency in apple\/Modules\/Features\/Home\/Project.swift/);
    assert.ok(violations.every((v) => /without declaring/.test(v.message)));
  });

  it("fails an import of a module that is neither a system module, a target nor an external module", () => {
    const root = copyOfTree();
    replace(root, "apple/Modules/Core/DesignSystem/Sources/StatusView.swift", "import SwiftUI\n", "import SwiftUI\nimport UIKit\n");
    assertViolations(root, ["ARCH-APPLE"], /DesignSystem imports UIKit, which is no system module, target or external module/);
  });

  it("fails a project dependency the policy does not allow", () => {
    const root = copyOfTree();
    replace(root, `${HOME_MODULE}/Project.swift`, '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),', '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),\n                .project(target: "SettingsFeature", path: "../Settings"),');
    assertViolations(root, ["ARCH-APPLE"], /HomeFeature depends on SettingsFeature, which apple.targets.HomeFeature.allowed does not list/);
  });

  it("fails an external dependency the policy does not allow", () => {
    const root = copyOfTree();
    replace(root, `${HOME_MODULE}/Project.swift`, '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),', '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),\n                .external(name: "NavigatorUI"),');
    const violations = assertViolations(root, ["ARCH-APPLE"], /HomeFeature depends on NavigatorUI, which apple.targets.HomeFeature.allowed does not list/);
    assert.equal(violations.length, 1);
  });

  it("fails an external dependency that is not an external module of the policy", () => {
    const root = copyOfTree();
    replace(root, `${HOME_MODULE}/Project.swift`, '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),', '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),\n                .external(name: "Alamofire"),');
    assertViolations(root, ["ARCH-APPLE"], /HomeFeature depends on external Alamofire, which apple.externalModules does not list/);
  });

  it("fails a dependency on a target the policy does not list", () => {
    const root = copyOfTree();
    replace(root, `${HOME_MODULE}/Project.swift`, '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),', '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),\n                .project(target: "Profile", path: "../Profile"),');
    const violations = assertViolations(root, ["ARCH-APPLE"], /HomeFeature depends on Profile, which apple.targets does not list/);
    assert.equal(violations.length, 1);
  });

  it("fails a project dependency whose path is not the project of its target", () => {
    const root = copyOfTree();
    replace(root, `${HOME_MODULE}/Project.swift`, '.project(target: "DesignSystem", path: "../../Core/DesignSystem")', '.project(target: "DesignSystem", path: "../../Core/CoreKit")');
    assertViolations(root, ["ARCH-APPLE"], /HomeFeature depends on DesignSystem in path "..\/..\/Core\/CoreKit", but apple.targets places it in Modules\/Core\/DesignSystem/);
  });

  it("fails a declared target without a policy entry", () => {
    const root = copyOfTree();
    replace(root, "apple/Modules/Core/DesignSystem/Project.swift", 'SemprecProject.framework("DesignSystem", resources: ["Resources/**"])', 'SemprecProject.framework("DesignSystem", resources: ["Resources/**"]), SemprecProject.tests("DesignSystemTests", for: "DesignSystem")');
    assertViolations(root, ["ARCH-APPLE"], /declares target DesignSystemTests, which has no entry in apple.targets/);
  });

  it("fails a target declared in another project than the policy says", () => {
    const root = copyOfTree();
    replace(root, "apple/Modules/Features/Settings/Project.swift", '"SettingsFeatureTests"', '"HomeFeatureTests"');
    assertViolations(root, ["ARCH-APPLE"], /declares target HomeFeatureTests, which apple.targets places in Modules\/Features\/Home/, /apple.targets lists SettingsFeatureTests, which no Project.swift/);
  });

  it("fails a policy target that no manifest declares", () => {
    const root = copyOfTree();
    editPolicy(root, (policy) => (policy.apple.targets.ProfileFeature = { project: "Modules/Features/Profile", sources: "Sources", allowed: [] }));
    assertViolations(root, ["ARCH-APPLE"], /apple.targets lists ProfileFeature, which no Project.swift in apple\/Modules\/Features\/Profile declares/);
  });

  it("fails a target name it cannot resolve to a string", () => {
    const root = copyOfTree();
    replace(root, "apple/Modules/Core/DesignSystem/Project.swift", 'SemprecProject.framework("DesignSystem"', "SemprecProject.framework(designSystemName");
    assertViolations(root, ["ARCH-APPLE"], /cannot resolve the target name designSystemName to a string/, /apple.targets lists DesignSystem, which no Project.swift/);
  });

  it("allows the UI tests' dependency on their app under test, and fails an import of that app", () => {
    const root = copyOfTree();
    write(root, `${UI_TESTS}/ImportProbe.swift`, "import XCTest\n@testable import Semprec\n");
    const violations = assertViolations(root, ["ARCH-APPLE"], /SemprecUITests imports Semprec, which apple.targets.SemprecUITests.allowed does not list \(allowed: none\); Semprec is its appUnderTest, which a UI test drives from outside and never imports/);
    assert.deepEqual(violations.map((v) => [v.file, v.line]), [[`${UI_TESTS}/ImportProbe.swift`, 2]]);
  });

  it("fails an import of an app module in the UI tests, and a dependency on one", () => {
    const root = copyOfTree();
    write(root, `${UI_TESTS}/ImportProbe.swift`, "import XCTest\nimport HomeFeature\n");
    assertViolations(root, ["ARCH-APPLE"], /SemprecUITests imports HomeFeature, which apple.targets.SemprecUITests.allowed does not list \(allowed: none\)$/, /SemprecUITests imports HomeFeature without declaring it/);
    const other = copyOfTree();
    replace(other, APP_MANIFEST, "dependencies: [.target(name: app)]", 'dependencies: [.target(name: app), .project(target: "HomeFeature", path: "../../Modules/Features/Home")]');
    assertViolations(other, ["ARCH-APPLE"], /SemprecUITests depends on HomeFeature, which apple.targets.SemprecUITests.allowed does not list \(allowed: none\)/);
  });

  it("fails a UI test target without a dependency on its app under test", () => {
    const root = copyOfTree();
    replace(root, APP_MANIFEST, "dependencies: [.target(name: app)]", "dependencies: []");
    const violations = assertViolations(root, ["ARCH-APPLE"], /SemprecUITests does not depend on Semprec, its apple.targets.SemprecUITests.appUnderTest, so it has no app to launch/);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, APP_MANIFEST);
  });

  it("checks a file the UI tests compile from another target against the UI tests' policy, not that target's", () => {
    const root = copyOfTree();
    const homeIdentifiers = `${HOME_MODULE}/Sources/HomeIdentifiers.swift`;
    const appIdentifiers = "apple/Projects/App/Sources/AppIdentifiers.swift";
    write(root, homeIdentifiers, `import CoreKit\n${readFileSync(path.join(MOBILE, homeIdentifiers), "utf8")}`);
    write(root, appIdentifiers, `import NavigatorUI\n${readFileSync(path.join(MOBILE, appIdentifiers), "utf8")}`);
    const violations = assertViolations(root, ["ARCH-APPLE"], /SemprecUITests imports CoreKit, which apple.targets.SemprecUITests.allowed does not list/, /SemprecUITests imports NavigatorUI, which apple.targets.SemprecUITests.allowed does not list/);
    assert.ok(violations.every((v) => v.message.startsWith("SemprecUITests ") && v.line === 1), violations.map((v) => v.message).join("\n"));
    assert.deepEqual([...new Set(violations.map((v) => v.file))].sort(), [appIdentifiers, homeIdentifiers].sort());
  });

  it("fails a file the UI tests compile from CoreKit's directory when it imports the Kotlin framework", () => {
    const root = copyOfTree();
    write(root, "apple/Modules/Core/CoreKit/Sources/Probe.swift", "import SharedSDK\n");
    replace(root, APP_MANIFEST, '"Sources/AppIdentifiers.swift",', '"Sources/AppIdentifiers.swift",\n                "../../Modules/Core/CoreKit/Sources/Probe.swift",');
    const violations = assertViolations(root, ["ARCH-APPLE"], /SemprecUITests compiles this file, which imports the Kotlin framework SharedSDK; apple.targets.SemprecUITests.allowed does not list it/);
    assert.deepEqual(violations.map((v) => [v.file, v.line]), [["apple/Modules/Core/CoreKit/Sources/Probe.swift", 1]]);
  });

  it("fails a UI tests source it cannot check: a glob outside their directory, a missing file, an unresolvable path", () => {
    const glob = copyOfTree();
    replace(glob, APP_MANIFEST, '"../../Modules/Features/Home/Sources/HomeIdentifiers.swift"', '"../../Modules/Features/Home/Sources/**"');
    assertViolations(glob, ["ARCH-APPLE"], /SemprecUITests compiles ..\/..\/Modules\/Features\/Home\/Sources\/\*\*, which is neither below its apple.targets.SemprecUITests.sources \(UITests\) nor one Swift file/);
    const missing = copyOfTree();
    replace(missing, APP_MANIFEST, '"Sources/AppIdentifiers.swift"', '"Sources/AppIdentifierz.swift"');
    assertViolations(missing, ["ARCH-APPLE"], /SemprecUITests compiles Sources\/AppIdentifierz.swift, which does not exist/);
    const unresolved = copyOfTree();
    replace(unresolved, APP_MANIFEST, '"Sources/AppIdentifiers.swift"', "appIdentifiersFile");
    assertViolations(unresolved, ["ARCH-APPLE"], /SemprecUITests: cannot resolve the source appIdentifiersFile to a path/);
  });

  it("fails an appUnderTest that apple.targets does not list, and the dependency it would have allowed", () => {
    const root = copyOfTree();
    editPolicy(root, (policy) => (policy.apple.targets.SemprecUITests.appUnderTest = "SemprecMac"));
    assertViolations(root, ["ARCH-APPLE"], /apple.targets.SemprecUITests.appUnderTest is "SemprecMac", which apple.targets does not list/, /SemprecUITests depends on Semprec, which apple.targets.SemprecUITests.allowed does not list/, /SemprecUITests does not depend on SemprecMac/);
  });

  it("fails a dependency name it cannot resolve to a string", () => {
    const root = copyOfTree();
    replace(root, "apple/Modules/Core/Dependencies/Project.swift", '.project(target: "CoreKit", path: "../CoreKit")', '.project(target: coreKitName, path: "../CoreKit")');
    assertViolations(root, ["ARCH-APPLE"], /Dependencies: cannot resolve the dependency .project\(coreKitName\) to a string/);
  });
});

describe("KMP-COMMON", () => {
  it("fails every platform import prefix in commonMain", () => {
    const root = copyOfTree();
    const imports = ["android.os.Build", "androidx.compose.runtime.Composable", "java.util.UUID", "javax.inject.Inject", "platform.Foundation.NSUUID", "kotlinx.cinterop.CPointer"];
    replace(root, `shared/domain/src/commonMain/${KOTLIN}/domain/PlaceholderItem.kt`, "package cz.semprec.app.domain\n", `package cz.semprec.app.domain\n\n${imports.map((name) => `import ${name}`).join("\n")}\n`);
    const violations = assertViolations(root, ["KMP-COMMON"]);
    assert.deepEqual(violations.map((v) => v.line), [3, 4, 5, 6, 7, 8]);
    for (const name of imports) assert.ok(violations.some((v) => v.message.includes(`platform API ${name} `)), name);
  });

  it("allows only the exact lifecycle ViewModel imports the policy lists", () => {
    const root = copyOfTree();
    replace(root, `${PRESENTATION}/ScreenViewModel.kt`, "import androidx.lifecycle.viewModelScope\n", "import androidx.lifecycle.viewModelScope\nimport androidx.lifecycle.SavedStateHandle\n");
    const violations = assertViolations(root, ["KMP-COMMON"], /androidx.lifecycle.SavedStateHandle/);
    assert.equal(violations.length, 1);
  });
});

describe("KMP-FRAMEWORK", () => {
  const coreKitTest = "apple/Modules/Core/CoreKit/Tests/EffectQueueTests.swift";
  const homeTest = `${HOME_MODULE}/Tests/HomeViewModelTests.swift`;

  it("allows the Kotlin framework in CoreKit's sources and in CoreKitTests, whose policy entry lists it", () => {
    const root = copyOfTree();
    replace(root, coreKitTest, "import XCTest\n", "@preconcurrency import SharedSDK\nimport XCTest\n");
    assertViolations(root, []);
  });

  it("fails an import of the Kotlin framework in another target's tests, the UI tests, a feature and the app", () => {
    const root = copyOfTree();
    replace(root, homeTest, "import XCTest\n", "import SharedSDK\nimport XCTest\n");
    replace(root, HOME_SCREEN_SWIFT, "import DesignSystem\n", "import DesignSystem\ninternal import SharedSDK\n");
    write(root, "apple/Projects/App/Sources/ProbeView.swift", "@preconcurrency import SharedSDK\n");
    write(root, `${UI_TESTS}/ImportProbe.swift`, "import XCTest\nimport SharedSDK\n");
    const violations = assertViolations(root, ["KMP-FRAMEWORK"], /imports SharedSDK; only the sources of CoreKit and CoreKitTests \(apple\/Modules\/Core\/CoreKit\/Sources\/, apple\/Modules\/Core\/CoreKit\/Tests\/\) import the Kotlin framework/);
    assert.deepEqual(violations.map((v) => v.file).sort(), [HOME_SCREEN_SWIFT, homeTest, "apple/Projects/App/Sources/ProbeView.swift", `${UI_TESTS}/ImportProbe.swift`].sort());
  });

  it("fails the import in CoreKitTests once its policy entry no longer lists the framework", () => {
    const root = copyOfTree();
    editPolicy(root, (policy) => (policy.apple.targets.CoreKitTests.allowed = policy.apple.targets.CoreKitTests.allowed.filter((name) => name !== "SharedSDK")));
    replace(root, coreKitTest, "import XCTest\n", "@preconcurrency import SharedSDK\nimport XCTest\n");
    const violations = assertViolations(root, ["KMP-FRAMEWORK"], /only the sources of CoreKit \(apple\/Modules\/Core\/CoreKit\/Sources\/\) import the Kotlin framework/);
    assert.ok(violations.some((v) => v.file === coreKitTest));
  });

  it("fails when gradle/project.properties names no framework to look for", () => {
    const root = copyOfTree();
    replace(root, "gradle/project.properties", "frameworkName=SharedSDK\n", "");
    assertViolations(root, ["KMP-FRAMEWORK", "APPLE-IDENTITY", "ARCH-APPLE"], /has no frameworkName, so the imports of the Kotlin framework cannot be checked/);
  });
});

describe("VM-BRIDGE", () => {
  it("fails a bridge whose deinit does not close its lease", () => {
    const root = copyOfTree();
    replace(root, `${COREKIT_SHARED}/SharedHomeScreenModel.swift`, "deinit {\n        lease.close()\n    }", "deinit {}");
    assertViolations(root, ["VM-BRIDGE"], /SharedHomeScreenModel does not call lease.close\(\) in deinit/);
  });

  it("fails a bridge that stores a shared ViewModel without a lease", () => {
    const root = copyOfTree();
    replace(root, `${COREKIT_SHARED}/SharedSettingsScreenModel.swift`, "let lease: SharedViewModelLease", "let lease: AnyObject");
    assertViolations(root, ["VM-BRIDGE"], /SharedSettingsScreenModel stores a shared ViewModel but no SharedViewModelLease/);
  });

  it("fails a second bridge of the same ViewModel", () => {
    const root = copyOfTree();
    append(root, `${COREKIT_SHARED}/SharedHomeScreenModel.swift`, "\nfinal class SecondHomeBridge {\n    private let viewModel: SharedSDK.HomeViewModel\n    let lease: SharedViewModelLease\n\n    deinit {\n        lease.close()\n    }\n}\n");
    assertViolations(root, ["VM-BRIDGE"], /HomeViewModel has 2 CoreKit bridges, exactly one must store it: SharedHomeScreenModel .*, SecondHomeBridge/);
  });

  it("fails a ViewModel without its commonTest test file", () => {
    const root = copyOfTree();
    remove(root, `shared/presentation/src/commonTest/${KOTLIN}/presentation/HomeViewModelTest.kt`);
    assertViolations(root, ["VM-BRIDGE"], /HomeViewModel has no HomeViewModelTest.kt in shared\/presentation\/src\/commonTest/);
  });

  it("fails a ViewModel no Android screen takes", () => {
    const root = copyOfTree();
    remove(root, `${HOME_FEATURE}/detail/DetailScreen.kt`);
    assertViolations(root, ["VM-BRIDGE"], /no Android \*Screen composable takes DetailViewModel as a parameter/);
  });

  it("fails a new ViewModel without test, bridge and screen once for each", () => {
    const root = copyOfTree();
    write(root, `${PRESENTATION}/ProfileViewModel.kt`, "package cz.semprec.app.presentation\n\nclass ProfileViewModel internal constructor() :\n    ScreenViewModel<SettingsState, SettingsAction, SettingsEffect>(SettingsState())\n");
    const violations = assertViolations(root, ["VM-BRIDGE"], /no ProfileViewModelTest.kt/, /ProfileViewModel has 0 CoreKit bridges/, /takes ProfileViewModel as a parameter/);
    assert.equal(violations.length, 3);
  });

  it("does not ask an abstract ViewModel for a test, a bridge or a screen", () => {
    const root = copyOfTree();
    write(root, `${PRESENTATION}/ListViewModel.kt`, LIST_VIEW_MODEL);
    assertViolations(root, []);
  });

  it("fails a concrete ViewModel that extends ScreenViewModel through an abstract one, once for each requirement", () => {
    const root = copyOfTree();
    write(root, `${PRESENTATION}/ListViewModel.kt`, LIST_VIEW_MODEL);
    write(root, `${PRESENTATION}/ProfileViewModel.kt`, "package cz.semprec.app.presentation\n\nclass ProfileViewModel internal constructor() : ListViewModel()\n");
    const violations = assertViolations(root, ["VM-BRIDGE"], /no ProfileViewModelTest.kt/, /ProfileViewModel has 0 CoreKit bridges/, /takes ProfileViewModel as a parameter/);
    assert.equal(violations.length, 3);
    assert.ok(violations.every((v) => v.file === `${PRESENTATION}/ProfileViewModel.kt` && v.line === 3));
  });

  it("follows the inheritance through several classes, and ends a cycle instead of following it", { timeout: 20_000 }, () => {
    const root = copyOfTree();
    write(root, `${PRESENTATION}/ListViewModel.kt`, LIST_VIEW_MODEL);
    write(root, `${PRESENTATION}/Deep.kt`, "package cz.semprec.app.presentation\n\nabstract class PagedViewModel : ListViewModel()\n\nclass DeepViewModel : PagedViewModel()\n\nabstract class LoopA : LoopB()\n\nabstract class LoopB : LoopA()\n\nclass LoopViewModel : LoopA()\n");
    const violations = assertViolations(root, ["VM-BRIDGE"], /no DeepViewModelTest.kt/, /DeepViewModel has 0 CoreKit bridges/, /takes DeepViewModel as a parameter/);
    assert.equal(violations.length, 3);
  });

  it("fails a CoreKit class that stores an indirect, an abstract or the base ViewModel type without a lease", () => {
    const root = copyOfTree();
    write(root, `${PRESENTATION}/ListViewModel.kt`, LIST_VIEW_MODEL);
    write(root, `${PRESENTATION}/ProfileViewModel.kt`, "package cz.semprec.app.presentation\n\nclass ProfileViewModel internal constructor() : ListViewModel()\n");
    write(root, `${COREKIT_SHARED}/LeaselessBridges.swift`, "final class ProfileBridge {\n    private let viewModel: SharedSDK.ProfileViewModel\n}\n\nfinal class ListBridge {\n    private let viewModel: SharedSDK.ListViewModel\n}\n\nfinal class BaseBridge {\n    private let viewModel: ScreenViewModel<AnyObject, AnyObject, AnyObject>\n}\n");
    const violations = assertViolations(root, ["VM-BRIDGE"]);
    for (const bridge of ["ProfileBridge", "ListBridge", "BaseBridge"]) {
      assert.ok(violations.some((v) => v.message === `${bridge} stores a shared ViewModel but no SharedViewModelLease`), bridge);
    }
  });
});

describe("NAV-OWNERSHIP", () => {
  it("fails a navigation import in a feature module", () => {
    const root = copyOfTree();
    replace(root, `${HOME_FEATURE}/home/HomeScreen.kt`, "import androidx.compose.ui.Modifier\n", "import androidx.compose.ui.Modifier\nimport androidx.navigation.NavController\n");
    const violations = assertViolations(root, ["NAV-OWNERSHIP"], /imports androidx.navigation.NavController in :android:feature:home, which navigation.gradleModules does not list/);
    assert.equal(violations.length, 1);
  });

  it("fails a navigation controller in shared code", () => {
    const root = copyOfTree();
    append(root, `${PRESENTATION}/HomeViewModelFactory.kt`, "\ninternal class NavigationHolder(val controller: NavHostController)\n");
    assertViolations(root, ["NAV-OWNERSHIP"], /uses NavHostController in :shared:presentation/);
  });

  it("fails a navigation controller in a ViewModel of the app module", () => {
    const root = copyOfTree();
    append(root, `android/app/src/main/${KOTLIN}/navigation/SceneNavigation.kt`, "\ninternal fun SceneNavigation.controller(): NavController? = null\n");
    assertViolations(root, ["NAV-OWNERSHIP"], /uses NavController in a ViewModel/);
  });

  it("fails a navigation controller in a *ViewModel.kt file of the app module", () => {
    const root = copyOfTree();
    write(root, `android/app/src/main/${KOTLIN}/ProbeViewModel.kt`, "package cz.semprec.app\n\nimport androidx.navigation.NavHostController\n\ninternal fun probe(stack: NavHostController) = stack\n");
    assertViolations(root, ["NAV-OWNERSHIP"], /imports androidx.navigation.NavHostController in a ViewModel/, /uses NavHostController in a ViewModel/);
  });

  it("fails a navigation controller in a class of the app module that extends a shared ViewModel through another", () => {
    const root = copyOfTree();
    write(root, `${PRESENTATION}/ListViewModel.kt`, LIST_VIEW_MODEL);
    write(root, `android/app/src/main/${KOTLIN}/Probe.kt`, "package cz.semprec.app\n\nimport cz.semprec.app.presentation.ListViewModel\n\ninternal class ProbeModel : ListViewModel() {\n    fun controller(): NavController? = null\n}\n");
    const [found] = assertViolations(root, ["NAV-OWNERSHIP"], /uses NavController in a ViewModel/);
    assert.equal(found.file, `android/app/src/main/${KOTLIN}/Probe.kt`);
  });

  it("fails a navigation controller in a class of the app module that extends the module's own ViewModel base", () => {
    const root = copyOfTree();
    write(root, `android/app/src/main/${KOTLIN}/AppModel.kt`, "package cz.semprec.app\n\nimport androidx.lifecycle.ViewModel\n\nabstract class AppModel : ViewModel()\n");
    write(root, `android/app/src/main/${KOTLIN}/Probe.kt`, "package cz.semprec.app\n\ninternal class ProbeModel : AppModel() {\n    fun controller(): NavHostController? = null\n}\n");
    assertViolations(root, ["NAV-OWNERSHIP"], /uses NavHostController in a ViewModel/);
  });

  it("fails NavigatorUI in an Apple feature even where the policy and the manifest allow the import", () => {
    const root = copyOfTree();
    editPolicy(root, (policy) => policy.apple.targets.HomeFeature.allowed.push("NavigatorUI"));
    replace(root, `${HOME_MODULE}/Project.swift`, '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),', '.project(target: "DesignSystem", path: "../../Core/DesignSystem"),\n                .external(name: "NavigatorUI"),');
    replace(root, HOME_SCREEN_SWIFT, "import DesignSystem\n", "import DesignSystem\nimport NavigatorUI\n");
    assertViolations(root, ["NAV-OWNERSHIP"], /imports NavigatorUI in HomeFeature, which navigation.appleTargets does not list/);
  });

  it("fails NavigatorUI in a ViewModel of the app target", () => {
    const root = copyOfTree();
    write(root, "apple/Projects/App/Sources/ProbeViewModel.swift", "import NavigatorUI\n\nfinal class ProbeViewModel {}\n");
    assertViolations(root, ["NAV-OWNERSHIP"], /imports NavigatorUI in a ViewModel/);
  });
});

describe("APPLE-IDENTITY", () => {
  it("fails a value that differs between the two files", () => {
    const root = copyOfTree();
    replace(root, PROJECT_CONFIGURATION, 'iosMinimum = "26.0"', 'iosMinimum = "18.0"');
    const [found] = assertViolations(root, ["APPLE-IDENTITY"], /iosMinimum is "18.0", but gradle\/project.properties has "26.0"/);
    assert.equal(found.file, PROJECT_CONFIGURATION);
  });

  it("fails a key missing from ProjectConfiguration.swift", () => {
    const root = copyOfTree();
    replace(root, PROJECT_CONFIGURATION, '    public static let versionCode = "1"\n', "");
    assertViolations(root, ["APPLE-IDENTITY"], /has no static let versionCode/);
  });

  it("fails a key missing from gradle/project.properties", () => {
    const root = copyOfTree();
    replace(root, "gradle/project.properties", "versionName=0.1.0\n", "");
    assertViolations(root, ["APPLE-IDENTITY"], /^has no versionName$/);
  });
});

describe("ORG-SCREEN", () => {
  it("fails an Android screen without its layout file", () => {
    const root = copyOfTree();
    remove(root, `${HOME_FEATURE}/home/HomeScreenLayout.kt`);
    const [found] = assertViolations(root, ["ORG-SCREEN"], /has no HomeScreenLayout.kt next to it/);
    assert.equal(found.file, `${HOME_FEATURE}/home/HomeScreen.kt`);
  });

  it("fails an Apple screen folder with a ViewModel but without the screen's view", () => {
    const root = copyOfTree();
    remove(root, HOME_SCREEN_SWIFT);
    const [found] = assertViolations(root, ["ORG-SCREEN"], /has no HomeScreen.swift next to it/);
    assert.equal(found.file, `${HOME_SWIFT_SCREENS}/HomeScreen/HomeViewModel.swift`);
  });
});

describe("COPY-PARITY", () => {
  const homeValues = "android/feature/home/src/main/res/values/strings.xml";
  const homeValuesCs = "android/feature/home/src/main/res/values-cs/strings.xml";
  const appValues = "android/app/src/main/res/values/strings.xml";

  it("fails an Android string that is not a copy key of its module", () => {
    const root = copyOfTree();
    replace(root, homeValues, "</resources>", '    <string name="home_subtitle">Subtitle</string>\n</resources>');
    replace(root, homeValuesCs, "</resources>", '    <string name="home_subtitle">Podtitul</string>\n</resources>');
    assertViolations(root, ["COPY-PARITY"], /home_subtitle is not a copy key of :android:feature:home/);
  });

  it("fails an Android copy key without a Czech translation", () => {
    const root = copyOfTree();
    replace(root, "android/feature/settings/src/main/res/values-cs/strings.xml", '    <string name="about_done">Hotovo</string>\n', "");
    assertViolations(root, ["COPY-PARITY"], /about_done has no Czech translation/);
  });

  it("fails a missing Android copy key and a Czech string without an English one", () => {
    const root = copyOfTree();
    replace(root, appValues, '    <string name="tab_settings">Settings</string>\n', "");
    assertViolations(root, ["COPY-PARITY"], /:android:app lacks the string tab_settings/, /tab_settings has no English value/);
  });

  it("fails the untranslatable app name once it becomes translatable, and when it is missing", () => {
    const root = copyOfTree();
    replace(root, appValues, ' translatable="false"', "");
    assertViolations(root, ["COPY-PARITY"], /app_name is listed in androidUntranslatable but lacks translatable="false"/);
    const other = copyOfTree();
    replace(other, appValues, '    <string name="app_name" translatable="false">Semprec</string>\n', "");
    assertViolations(other, ["COPY-PARITY"], /:android:app lacks the untranslatable string app_name/);
  });

  it("fails string resources of a module without a copy entry", () => {
    const root = copyOfTree();
    write(root, "shared/core/src/main/res/values/strings.xml", '<resources>\n    <string name="core_name">Core</string>\n</resources>\n');
    assertViolations(root, ["COPY-PARITY"], /:shared:core has string resources but no entry in copy/);
  });

  it("fails string resources in a Kotlin Multiplatform module's androidMain, and in a values-* directory alone", () => {
    const root = copyOfTree();
    write(root, "shared/core/src/androidMain/res/values/strings.xml", '<resources>\n    <string name="core_android_main">Shown text</string>\n</resources>\n');
    write(root, "shared/core/src/androidMain/res/values-cs/strings.xml", '<resources>\n    <string name="core_android_main">Zobrazený text</string>\n</resources>\n');
    write(root, "shared/data/src/main/res/values-cs/strings.xml", '<resources>\n    <string name="data_name">Data</string>\n</resources>\n');
    const violations = assertViolations(root, ["COPY-PARITY"], /:shared:core has string resources but no entry in copy/, /:shared:data has string resources but no entry in copy/);
    assert.equal(violations.length, 2);
    assert.equal(violations.find((v) => v.message.startsWith(":shared:core")).file, "shared/core/src/androidMain/res/values/strings.xml");
  });

  it("fails a string in a source set that not every build compiles, a copy key there included", () => {
    const root = copyOfTree();
    write(root, "android/feature/home/src/debug/res/values/strings.xml", '<resources>\n    <string name="home_debug">Debug</string>\n</resources>\n');
    write(root, "android/feature/home/src/androidMain/res/values/strings.xml", '<resources>\n    <string name="home_android_main">Ignored</string>\n</resources>\n');
    write(root, "shared/core/src/androidDebug/res/values/strings.xml", '<resources>\n    <string name="core_debug">Debug</string>\n</resources>\n');
    const violations = assertViolations(root, ["COPY-PARITY"], /home_debug is in src\/debug\/res, which not every build of :android:feature:home compiles/, /home_android_main is in src\/androidMain\/res, which not every build of :android:feature:home compiles/, /core_debug is in src\/androidDebug\/res/, /:shared:core has string resources but no entry/);
    assert.equal(violations.length, 4);
    const other = copyOfTree();
    replace(other, homeValues, '    <string name="home_empty">There are no items yet.</string>\n', "");
    write(other, "android/feature/home/src/release/res/values/strings.xml", '<resources>\n    <string name="home_empty">There are no items yet.</string>\n</resources>\n');
    assertViolations(other, ["COPY-PARITY"], /:android:feature:home lacks the string home_empty/, /home_empty is in src\/release\/res/, /home_empty has no English value/);
  });

  it("ignores the string resources of test source sets", () => {
    const root = copyOfTree();
    for (const sourceSet of ["test", "androidTest", "testDebug"]) {
      write(root, `android/feature/home/src/${sourceSet}/res/values/strings.xml`, '<resources>\n    <string name="probe">Probe</string>\n</resources>\n');
    }
    write(root, "shared/core/src/androidUnitTest/res/values/strings.xml", '<resources>\n    <string name="probe">Probe</string>\n</resources>\n');
    assertViolations(root, []);
  });

  it("fails an empty Android value, English or Czech, a blank plural item among them", () => {
    const root = copyOfTree();
    replace(root, homeValuesCs, '<string name="home_empty">Zatím tu nejsou žádné položky.</string>', '<string name="home_empty"></string>');
    replace(root, homeValues, '<string name="home_title">Home</string>', '<string name="home_title">""</string>');
    replace(root, "android/feature/settings/src/main/res/values-cs/strings.xml", '<string name="about_done">Hotovo</string>', '<string name="about_done" />');
    replace(root, appValues, '>Semprec</string>', ">  </string>");
    const violations = assertViolations(root, ["COPY-PARITY"], /^home_empty has an empty Czech translation$/, /^home_title has an empty English value$/, /^about_done has an empty Czech translation$/, /^app_name has an empty value$/);
    assert.equal(violations.length, 4);
    const other = copyOfTree();
    editPolicy(other, (policy) => policy.copy.find((entry) => entry.android === ":android:feature:home").keys.push("home.count"));
    replace(other, homeValues, "</resources>", '    <plurals name="home_count">\n        <item quantity="one">%d item</item>\n        <item quantity="other">%d items</item>\n    </plurals>\n</resources>');
    replace(other, homeValuesCs, "</resources>", '    <plurals name="home_count">\n        <item quantity="one">%d položka</item>\n        <item quantity="other"> </item>\n    </plurals>\n</resources>');
    const unit = (value) => ({ stringUnit: { state: "translated", value } });
    editJson(other, HOME_CATALOG, (catalog) => (catalog.strings["home.count"] = { localizations: { en: unit("%lld items"), cs: unit("%lld položek") } }));
    const [found] = assertViolations(other, ["COPY-PARITY"], /^home_count has an empty Czech translation$/);
    assert.equal(found.file, homeValuesCs);
  });

  it("fails an Apple copy key without a translated Czech value", () => {
    const root = copyOfTree();
    editJson(root, SETTINGS_CATALOG, (catalog) => (catalog.strings["about.done"].localizations.cs.stringUnit.state = "needs_review"));
    assertViolations(root, ["COPY-PARITY"], /about.done has no translated, non-empty Czech \(cs\) value/);
  });

  it("fails an Apple copy key without a translated, non-empty English value", () => {
    const root = copyOfTree();
    editJson(root, HOME_CATALOG, (catalog) => {
      delete catalog.strings["home.title"].localizations.en;
      catalog.strings["home.empty"].localizations.en.stringUnit.value = "";
      catalog.strings["detail.title"].localizations.en.stringUnit.state = "new";
    });
    const violations = assertViolations(root, ["COPY-PARITY"], /^home.title has no translated, non-empty English \(en\) value$/, /^home.empty has no translated, non-empty English \(en\) value$/, /^detail.title has no translated, non-empty English \(en\) value$/);
    assert.equal(violations.length, 3);
  });

  it("fails an Apple copy key whose Czech value is only whitespace", () => {
    const root = copyOfTree();
    editJson(root, SETTINGS_CATALOG, (catalog) => (catalog.strings["about.done"].localizations.cs.stringUnit.value = "  "));
    assertViolations(root, ["COPY-PARITY"], /^about.done has no translated, non-empty Czech \(cs\) value$/);
  });

  it("fails a String Catalog whose source language is not English", () => {
    const root = copyOfTree();
    editJson(root, APP_CATALOG, (catalog) => (catalog.sourceLanguage = "cs"));
    const [found] = assertViolations(root, ["COPY-PARITY"], /has the sourceLanguage "cs"; copy is written in English, so it must be "en"/);
    assert.equal(found.file, APP_CATALOG);
  });

  it("fails a missing Apple copy key", () => {
    const root = copyOfTree();
    editJson(root, APP_CATALOG, (catalog) => delete catalog.strings["tab.settings"]);
    assertViolations(root, ["COPY-PARITY"], /Semprec lacks the key tab.settings/);
  });

  it("fails the Android-only key in a String Catalog, and any other key the policy does not list", () => {
    const root = copyOfTree();
    const unit = (value) => ({ stringUnit: { state: "translated", value } });
    editJson(root, HOME_CATALOG, (catalog) => {
      catalog.strings["detail.back"] = { localizations: { en: unit("Back"), cs: unit("Zpět") } };
      catalog.strings["home.subtitle"] = { localizations: { en: unit("Subtitle"), cs: unit("Podtitul") } };
    });
    assertViolations(root, ["COPY-PARITY"], /has the key detail.back, but it is Android-only/, /has the key home.subtitle, but it is not a copy key of HomeFeature/);
  });

  it("fails a String Catalog that is not valid JSON, and a target without a catalog", () => {
    const root = copyOfTree();
    write(root, HOME_CATALOG, "{ not json");
    assertViolations(root, ["COPY-PARITY"], /is not valid JSON/);
    const other = copyOfTree();
    remove(other, APP_CATALOG);
    assertViolations(other, ["COPY-PARITY"], /Semprec has no String Catalog/, /Semprec lacks the key tab.home/);
  });

  it("fails a String Catalog of no copy entry, and a copy entry naming no Apple target", () => {
    const root = copyOfTree();
    write(root, "apple/Modules/Core/CoreKit/Resources/Localizable.xcstrings", '{ "sourceLanguage" : "en", "strings" : {}, "version" : "1.0" }\n');
    assertViolations(root, ["COPY-PARITY"], /belongs to no Apple target in copy/);
    const other = copyOfTree();
    editPolicy(other, (policy) => (policy.copy[0].apple = "Profile"));
    assertViolations(other, ["COPY-PARITY"], /copy names the Apple target Profile, which apple.targets does not list/, /belongs to no Apple target in copy/);
  });
});

describe("WRAPPER", () => {
  it("fails a jar that differs from the recorded checksum", () => {
    const root = copyOfTree();
    append(root, "gradle/wrapper/gradle-wrapper.jar", "x");
    assertViolations(root, ["WRAPPER"], /has SHA-256 [0-9a-f]{64}, but gradle\/wrapper\/gradle-wrapper.jar.sha256 records 81a82aae/);
  });

  it("fails without a recorded checksum or without the jar", () => {
    const root = copyOfTree();
    remove(root, "gradle/wrapper/gradle-wrapper.jar.sha256");
    assertViolations(root, ["WRAPPER"], /does not exist or is empty/);
    const other = copyOfTree();
    remove(other, "gradle/wrapper/gradle-wrapper.jar");
    assertViolations(other, ["WRAPPER"], /^does not exist$/);
  });
});

describe("the command", () => {
  it("exits 1 and prints each violation with its file and line", () => {
    const root = copyOfTree();
    replace(root, `shared/domain/src/commonMain/${KOTLIN}/domain/PlaceholderItem.kt`, "package cz.semprec.app.domain\n", "package cz.semprec.app.domain\n\nimport java.util.UUID\n");
    const { status, output } = run(root);
    assert.equal(status, 1, output);
    assert.match(output, /^FAIL KMP-COMMON /m);
    assert.match(output, new RegExp(`mobile/shared/domain/src/commonMain/${KOTLIN}/domain/PlaceholderItem.kt:3: imports the platform API java.util.UUID`));
    assert.match(output, /1 of 10 rules failed with 1 violation/);
  });

  it("exits 1 on a violating tree when run through a symlinked path", () => {
    const root = copyOfTree();
    replace(root, `shared/domain/src/commonMain/${KOTLIN}/domain/PlaceholderItem.kt`, "package cz.semprec.app.domain\n", "package cz.semprec.app.domain\n\nimport java.util.UUID\n");
    const { status, output } = runThroughSymlink(path.dirname(root), "mobile/scripts/architecture.mjs");
    assert.equal(status, 1, output);
    assert.match(output, /^FAIL KMP-COMMON /m);
    assert.match(output, /1 of 10 rules failed with 1 violation/);
  });

  it("exits 1 when the policy cannot be read or lacks a section", () => {
    const root = copyOfTree();
    write(root, POLICY_FILE, "{");
    let result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.output, /architecture: cannot read scripts\/architecture-policy.json/);
    write(root, POLICY_FILE, JSON.stringify({ gradle: { modules: {} } }));
    result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.output, /architecture-policy.json lacks kotlinCommon.allowedImports, apple.systemModules/);
  });

  it("exits 1 when given more than one directory", () => {
    const { status, output } = run(MOBILE, MOBILE);
    assert.equal(status, 1);
    assert.match(output, /expected at most one directory argument, got 2/);
  });
});
