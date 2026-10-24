/**
 * Tests of verify and kmp-framework that need no real toolchain: the JDK range both accept, which belongs to the
 * pinned Gradle version, the SwiftLint version verify requires, the commands verify's apple step runs, and the Gradle
 * task and embed folder kmp-framework picks for each Xcode SDK and configuration. Each test runs a copy of the script
 * in a scratch mobile directory with fake `java`, `swiftlint`, `tuist`, `xcodebuild`, `xcrun` and `gradlew`
 * executables, so neither Gradle, Xcode nor SwiftLint runs: the scratch directory has no Gradle project, a fake that
 * is not told to succeed fails, and the fakes that succeed record what they were asked to do. Only kmp-framework's
 * lookup without JAVA_HOME asks this Mac's /usr/libexec/java_home.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(SCRIPTS, "..");
const WRAPPER_PROPERTIES = "gradle/wrapper/gradle-wrapper.properties";
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const onMac = process.platform === "darwin";
const onAppleSilicon = onMac && process.arch === "arm64";

const temporaryDirectories = [];
after(() => {
  for (const dir of temporaryDirectories) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "mobile-toolchain-"));
  temporaryDirectories.push(dir);
  return dir;
}

function write(file, text, executable = false) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (executable) chmodSync(file, 0o755);
}

/** A directory with `bin/java` that reports `version` the way a JDK does, on stderr. */
function fakeJdk(version) {
  const home = path.join(scratch(), `jdk-${version}`);
  write(path.join(home, "bin/java"), `#!/bin/sh\necho 'openjdk version "${version}" 2026-01-20' >&2\n`, true);
  return home;
}

/** A scratch mobile directory holding a copy of `script` and the real Gradle wrapper properties. */
function mobileWith(script) {
  const root = path.join(scratch(), "mobile");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(path.join(SCRIPTS, script), path.join(root, "scripts", script));
  chmodSync(path.join(root, "scripts", script), 0o755);
  write(path.join(root, WRAPPER_PROPERTIES), readFileSync(path.join(MOBILE, WRAPPER_PROPERTIES), "utf8"));
  return root;
}

function run(file, args, env) {
  const result = spawnSync(file, args, { encoding: "utf8", env });
  return { status: result.status, output: result.stdout + result.stderr };
}

/** The lines verify prints under "Missing:" for a prerequisite that failed. */
function missingLines(output) {
  return output.split("\n").filter((line) => /^ {3}- /.test(line));
}

describe("verify: the JDK range", () => {
  const verifyAndroid = (javaHome, root = mobileWith("verify")) =>
    run(path.join(root, "scripts/verify"), ["android"], {
      PATH: SYSTEM_PATH,
      HOME: scratch(),
      JAVA_HOME: javaHome,
      ANDROID_HOME: scratch(),
    });

  for (const version of ["17.0.21", "21.0.13", "23.0.2"]) {
    it(`accepts JDK ${version}`, () => {
      const { output } = verifyAndroid(fakeJdk(version));
      assert.deepEqual(missingLines(output), [], output);
      assert.match(output, new RegExp(`PASS \\(JDK ${version.replaceAll(".", "\\.")} \\(JAVA_HOME\\)`), output);
    });
  }

  for (const version of ["27", "24", "16.0.2", "1.8.0_402"]) {
    it(`rejects JDK ${version} up front, naming the range and the Gradle version`, () => {
      const { status, output } = verifyAndroid(fakeJdk(version));
      assert.equal(status, 1, output);
      const missing = missingLines(output);
      assert.equal(missing.length, 1, output);
      assert.match(missing[0], new RegExp(`is Java ${version.replaceAll(".", "\\.")}; the build runs on JDK 17 to 23 only .*Gradle 8\\.13`));
      assert.match(output, /NOT RUN +gradle assemble \+ unit tests \+ lint/);
    });
  }

  it("fails when the wrapper pins another Gradle than the one the range is for", () => {
    const root = mobileWith("verify");
    const file = path.join(root, WRAPPER_PROPERTIES);
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("gradle-8.13-bin.zip"), `${WRAPPER_PROPERTIES} no longer pins Gradle 8.13; update this test`);
    writeFileSync(file, text.replace("gradle-8.13-bin.zip", "gradle-8.14-bin.zip"));
    const { status, output } = verifyAndroid(fakeJdk("21.0.13"), root);
    assert.equal(status, 1, output);
    assert.match(missingLines(output).join("\n"), /pins Gradle 8\.14, but the JDK range 17 to 23 is the one for Gradle 8\.13/);
  });
});

describe("verify: the SwiftLint pin", () => {
  /** Runs `verify apple` with fake Apple tools and a .swiftlint.yml of `config`; `swiftlint` reports `version`. */
  const verifyApple = (config, version) => {
    const root = mobileWith("verify");
    if (config !== null) write(path.join(root, "apple/.swiftlint.yml"), config);
    write(path.join(root, "apple/.tuist-version"), "4.213.0\n");
    const bin = path.join(scratch(), "bin");
    write(path.join(bin, "xcodebuild"), '#!/bin/sh\n[ "$1" = -version ] && { echo "Xcode 26.0"; echo "Build version 17A1"; exit 0; }\nexit 1\n', true);
    write(path.join(bin, "tuist"), '#!/bin/sh\n[ "$1" = version ] && { echo 4.213.0; exit 0; }\nexit 1\n', true);
    if (version !== null) write(path.join(bin, "swiftlint"), `#!/bin/sh\n[ "$1" = version ] && { echo ${version}; exit 0; }\nexit 3\n`, true);
    return run(path.join(root, "scripts/verify"), ["apple"], {
      PATH: `${bin}:${SYSTEM_PATH}`,
      HOME: scratch(),
      JAVA_HOME: fakeJdk("21.0.13"),
    });
  };
  const swiftlintLines = (output) => missingLines(output).filter((line) => /swiftlint/i.test(line));

  it("accepts the version .swiftlint.yml pins, also quoted and with a comment", () => {
    for (const config of ["swiftlint_version: 0.65.1\n", "included:\n  - Sources\nswiftlint_version: \"0.65.1\" # the pin\n"]) {
      const { output } = verifyApple(config, "0.65.1");
      assert.deepEqual(swiftlintLines(output), [], output);
      if (onMac && process.arch === "arm64") assert.match(output, /PASS \(.*SwiftLint 0\.65\.1/, output);
    }
  });

  it("fails another SwiftLint version, before swiftlint lint runs", () => {
    const { status, output } = verifyApple("swiftlint_version: 0.65.1\n", "0.64.0");
    assert.equal(status, 1, output);
    assert.deepEqual(swiftlintLines(output), ["   - swiftlint is 0.64.0, but mobile/apple/.swiftlint.yml pins 0.65.1 (swiftlint_version)"]);
    assert.match(output, /NOT RUN +swiftlint lint --strict/);
  });

  it("fails a configuration without swiftlint_version, or without one exact version", () => {
    let { output } = verifyApple("included:\n  - Sources\n", "0.65.1");
    assert.deepEqual(swiftlintLines(output), ["   - mobile/apple/.swiftlint.yml has no swiftlint_version, the SwiftLint version this repository pins"]);
    ({ output } = verifyApple(null, "0.65.1"));
    assert.match(swiftlintLines(output).join("\n"), /has no swiftlint_version/);
    ({ output } = verifyApple("swiftlint_version: '>= 0.65.0'\n", "0.65.1"));
    assert.deepEqual(swiftlintLines(output), ["   - swiftlint_version in mobile/apple/.swiftlint.yml is '>= 0.65.0', which is not one exact version"]);
  });

  it("fails when swiftlint is not on PATH, naming the pinned version", () => {
    const { output } = verifyApple("swiftlint_version: 0.65.1\n", null);
    assert.deepEqual(swiftlintLines(output), ["   - swiftlint is not on PATH; install SwiftLint 0.65.1, the version mobile/apple/.swiftlint.yml pins"]);
  });
});

describe("verify: the apple step's commands", { skip: !onAppleSilicon && "verify's apple step runs on Apple silicon only" }, () => {
  const UDID = "0A1B2C3D-0000-4000-8000-00000000A1B2";
  const END = "<end of call>";
  /**
   * Runs `verify apple` plus `args` with fake Apple tools that succeed. The fake xcodebuild records each call's
   * arguments; a test writes a result bundle whose summary reports one passed test, `uiTestsPassed` for the UI test
   * scheme. Returns the output and every recorded xcodebuild call but `-version`, as an argument list.
   */
  const verifyApple = (args = [], { uiTestsPassed = 1 } = {}) => {
    const root = mobileWith("verify");
    write(path.join(root, "apple/.swiftlint.yml"), "swiftlint_version: 0.65.1\n");
    write(path.join(root, "apple/.tuist-version"), "4.213.0\n");
    const bin = path.join(scratch(), "bin");
    const calls = path.join(scratch(), "xcodebuild-calls");
    write(
      path.join(bin, "xcodebuild"),
      `#!/bin/sh
[ "$1" = -version ] && { echo "Xcode 26.0"; echo "Build version 17A1"; exit 0; }
printf '%s\\n' "$@" '${END}' >>"$CALLS"
[ "$1" = test ] || exit 0
action=$1
while [ $# -gt 1 ]; do
    case $1 in -scheme) scheme=$2 ;; -resultBundlePath) bundle=$2 ;; esac
    shift
done
passed=1
[ "$scheme" = SemprecUITests ] && passed=$UI_TESTS_PASSED
mkdir -p "$bundle" && printf '{"passedTests":%s,"failedTests":0}' "$passed" >"$bundle/summary.json"
`,
      true,
    );
    write(
      path.join(bin, "xcrun"),
      `#!/bin/sh
if [ "$1" = simctl ]; then echo "    iPhone 17 (${UDID}) (Booted)"; exit 0; fi
if [ "$1" = xcresulttool ]; then
    while [ $# -gt 1 ]; do [ "$1" = --path ] && bundle=$2; shift; done
    exec cat "$bundle/summary.json"
fi
exit 1
`,
      true,
    );
    write(path.join(bin, "tuist"), '#!/bin/sh\n[ "$1" = version ] && echo 4.213.0\nexit 0\n', true);
    write(path.join(bin, "swiftlint"), '#!/bin/sh\n[ "$1" = version ] && echo 0.65.1\nexit 0\n', true);
    const result = run(path.join(root, "scripts/verify"), ["apple", ...args], {
      PATH: `${bin}:${SYSTEM_PATH}`,
      HOME: scratch(),
      JAVA_HOME: fakeJdk("21.0.13"),
      CALLS: calls,
      UI_TESTS_PASSED: String(uiTestsPassed),
    });
    const recorded = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    const xcodebuild = recorded
      .split(`${END}\n`)
      .filter(Boolean)
      .map((call) => call.replace(/\n$/, "").split("\n"));
    return { ...result, root, xcodebuild };
  };

  /** A call as "<action> <scheme> <configuration or -> <destination>", plus "unsigned" for CODE_SIGNING_ALLOWED=NO. */
  const shown = (call) => {
    const value = (flag) => (call.includes(flag) ? call[call.indexOf(flag) + 1] : "-");
    const unsigned = call.includes("CODE_SIGNING_ALLOWED=NO") ? " unsigned" : "";
    return `${call[0]} ${value("-scheme")} ${value("-configuration")} ${value("-destination")}${unsigned}`;
  };

  const BUILDS = ["Debug", "Release"].flatMap((configuration) =>
    ["iOS Simulator", "iOS", "macOS"].map((platform) => `build Semprec ${configuration} generic/platform=${platform} unsigned`),
  );

  /** The UI test target is iOS only and outside the Semprec scheme, so verify builds it without a device. */
  const UI_TEST_BUILD = "build-for-testing SemprecUITests - generic/platform=iOS Simulator unsigned";

  it("builds Debug and Release for the iOS Simulator, an iOS device and macOS, then the UI tests, then tests on macOS", () => {
    const { status, output, root, xcodebuild } = verifyApple();
    assert.equal(status, 0, output);
    assert.deepEqual(xcodebuild.map(shown), [...BUILDS, UI_TEST_BUILD, "test Semprec - platform=macOS,arch=arm64"], output);
    for (const call of xcodebuild) {
      assert.equal(call[call.indexOf("-workspace") + 1], "Semprec.xcworkspace", call.join(" "));
      assert.equal(call[call.indexOf("-derivedDataPath") + 1], path.join(root, "apple/build/DerivedData"), call.join(" "));
    }
    for (const configuration of ["Debug", "Release"]) {
      assert.match(output, new RegExp(`^  PASS +build ${configuration}, iOS device +\\d+s`, "m"), output);
    }
  });

  it("lists the tests and the UI tests on an iOS simulator as NOT RUN without --ios-simulator, naming the flag", () => {
    const { output } = verifyApple();
    assert.match(output, /^  NOT RUN +test on an iOS simulator +pass --ios-simulator <UDID> to run it$/m, output);
    assert.match(output, /^  NOT RUN +UI tests on an iOS simulator +pass --ios-simulator <UDID> to run it; SemprecUITests runs on iOS only$/m, output);
  });

  it("runs the Semprec tests and then the SemprecUITests scheme on the simulator --ios-simulator names", () => {
    const { status, output, xcodebuild } = verifyApple(["--ios-simulator", UDID]);
    assert.equal(status, 0, output);
    assert.deepEqual(
      xcodebuild.map(shown),
      [...BUILDS, UI_TEST_BUILD, "test Semprec - platform=macOS,arch=arm64", `test Semprec - id=${UDID}`, `test SemprecUITests - id=${UDID}`],
      output,
    );
    assert.match(output, new RegExp(`^  PASS +UI tests on iOS simulator ${UDID} +\\d+s +1 tests passed$`, "m"), output);
    assert.doesNotMatch(output, /NOT RUN/, output);
  });

  it("fails the UI tests when their result bundle reports no passed test", () => {
    const { status, output } = verifyApple(["--ios-simulator", UDID], { uiTestsPassed: 0 });
    assert.equal(status, 1, output);
    assert.match(output, new RegExp(`^  FAIL +UI tests on iOS simulator ${UDID} `, "m"), output);
    assert.match(output, /a test run must pass at least one test and fail none/, output);
  });
});

describe("kmp-framework: the SDK and the configuration", { skip: !onMac && "kmp-framework runs on macOS only" }, () => {
  /** Runs kmp-framework in `mode` as an Xcode build phase would; the fake gradlew prints the arguments it got. */
  const phase = (mode, env) => {
    const root = mobileWith("kmp-framework");
    write(path.join(root, "gradlew"), '#!/bin/sh\necho "gradlew $*"\n', true);
    return run(path.join(root, "scripts/kmp-framework"), [mode], {
      CONFIGURATION: "Debug",
      ARCHS: "arm64",
      TARGET_BUILD_DIR: scratch(),
      BUILT_PRODUCTS_DIR: scratch(),
      HOME: scratch(),
      PATH: SYSTEM_PATH,
      JAVA_HOME: fakeJdk("21.0.13"),
      ...env,
    });
  };
  const lines = (output) => output.trim().split("\n");
  const SDKS = [
    { sdk: "iphoneos27.1", target: "IosArm64", core: "CoreKit.framework/Frameworks", app: "Semprec.app/Frameworks" },
    { sdk: "iphonesimulator27.1", target: "IosSimulatorArm64", core: "CoreKit.framework/Frameworks", app: "Semprec.app/Frameworks" },
    { sdk: "macosx27.0", target: "MacosArm64", core: "CoreKit.framework/Versions/A/Frameworks", app: "Semprec.app/Contents/Frameworks" },
  ];

  for (const { sdk, target, core } of SDKS) {
    for (const configuration of ["Debug", "Release"]) {
      it(`--build-only runs exactly assemble${configuration}AppleFrameworkForXcode${target} for ${sdk}, ${configuration}`, () => {
        const { status, output } = phase("--build-only", {
          SDK_NAME: sdk,
          CONFIGURATION: configuration,
          FRAMEWORKS_FOLDER_PATH: core,
          WRAPPER_EXTENSION: "framework",
        });
        assert.equal(status, 0, output);
        assert.deepEqual(lines(output), [`gradlew :shared:umbrella:assemble${configuration}AppleFrameworkForXcode${target} --no-daemon`]);
      });
    }
  }

  for (const { sdk, app } of SDKS) {
    it(`--embed runs embedAndSignAppleFrameworkForXcode for the app's ${app} on ${sdk}`, () => {
      for (const configuration of ["Debug", "Release"]) {
        const { status, output } = phase("--embed", {
          SDK_NAME: sdk,
          CONFIGURATION: configuration,
          FRAMEWORKS_FOLDER_PATH: app,
          WRAPPER_EXTENSION: "app",
        });
        assert.equal(status, 0, output);
        assert.deepEqual(lines(output), ["gradlew :shared:umbrella:embedAndSignAppleFrameworkForXcode --no-daemon"]);
      }
    });
  }

  it("--embed refuses the other platform's frameworks folder and a target that is no app, without running Gradle", () => {
    const refused = [
      { SDK_NAME: "iphoneos27.1", FRAMEWORKS_FOLDER_PATH: "Semprec.app/Contents/Frameworks", WRAPPER_EXTENSION: "app" },
      { SDK_NAME: "iphonesimulator27.1", FRAMEWORKS_FOLDER_PATH: "Semprec.app/Contents/Frameworks", WRAPPER_EXTENSION: "app" },
      { SDK_NAME: "macosx27.0", FRAMEWORKS_FOLDER_PATH: "Semprec.app/Frameworks", WRAPPER_EXTENSION: "app" },
      { SDK_NAME: "iphoneos27.1", FRAMEWORKS_FOLDER_PATH: "CoreKit.framework/Frameworks", WRAPPER_EXTENSION: "framework" },
      { SDK_NAME: "macosx27.0", FRAMEWORKS_FOLDER_PATH: "Semprec.app/Contents/Frameworks" },
    ];
    for (const env of refused) {
      const { status, output } = phase("--embed", env);
      assert.equal(status, 2, `${JSON.stringify(env)}\n${output}`);
      assert.deepEqual(lines(output), [
        `error: kmp-framework: only the application target embeds the Kotlin framework (got FRAMEWORKS_FOLDER_PATH '${env.FRAMEWORKS_FOLDER_PATH}')`,
      ]);
    }
  });

  it("fails an SDK, a configuration or architectures it builds no framework for, without running Gradle", () => {
    const cases = [
      [{ SDK_NAME: "appletvos27.0" }, "unsupported SDK 'appletvos27.0'; supported are iphoneos, iphonesimulator and macosx"],
      [{ SDK_NAME: "xrsimulator27.0" }, "unsupported SDK 'xrsimulator27.0'; supported are iphoneos, iphonesimulator and macosx"],
      [{ SDK_NAME: "iphoneos27.1", CONFIGURATION: "Profile" }, "unsupported configuration 'Profile'; only Debug and Release exist"],
      [{ SDK_NAME: "iphoneos27.1", ARCHS: "arm64 x86_64" }, "unsupported architectures 'arm64 x86_64'; the Kotlin framework is built for arm64 only"],
    ];
    for (const [env, message] of cases) {
      const { status, output } = phase("--build-only", { FRAMEWORKS_FOLDER_PATH: "CoreKit.framework/Frameworks", ...env });
      assert.equal(status, 2, output);
      assert.deepEqual(lines(output), [`error: kmp-framework: ${message}`]);
    }
  });
});

describe("kmp-framework: the JDK range", { skip: !onMac && "kmp-framework runs on macOS only" }, () => {
  /** Runs `kmp-framework --build-only` as a macOS Debug build phase would; the fake gradlew prints what it got. */
  const buildPhase = (env) => {
    const root = mobileWith("kmp-framework");
    write(path.join(root, "gradlew"), '#!/bin/sh\necho "gradlew JAVA_HOME=${JAVA_HOME:-} $*"\n', true);
    return run(path.join(root, "scripts/kmp-framework"), ["--build-only"], {
      CONFIGURATION: "Debug",
      SDK_NAME: "macosx26.0",
      ARCHS: "arm64",
      TARGET_BUILD_DIR: scratch(),
      BUILT_PRODUCTS_DIR: scratch(),
      FRAMEWORKS_FOLDER_PATH: "CoreKit.framework/Versions/A/Frameworks",
      HOME: scratch(),
      PATH: SYSTEM_PATH,
      ...env,
    });
  };

  it("runs Gradle with a JAVA_HOME inside the range", () => {
    const home = fakeJdk("21.0.13");
    const { status, output } = buildPhase({ JAVA_HOME: home });
    assert.equal(status, 0, output);
    assert.match(output, new RegExp(`gradlew JAVA_HOME=${home} :shared:umbrella:assembleDebugAppleFrameworkForXcodeMacosArm64 --no-daemon`));
  });

  it("fails a JAVA_HOME outside the range without running Gradle", () => {
    for (const version of ["27", "16.0.2"]) {
      const home = fakeJdk(version);
      const { status, output } = buildPhase({ JAVA_HOME: home });
      assert.equal(status, 2, output);
      assert.match(output, new RegExp(`error: kmp-framework: JAVA_HOME is '${home}', which runs Java ${version.split(".")[0]}; the build runs only on JDK 17 to 23 .*Gradle 8\\.13`));
      assert.doesNotMatch(output, /gradlew/);
    }
  });

  it("never runs Gradle on a java from PATH outside the range when JAVA_HOME is not set", () => {
    // /usr/libexec/java_home answers from this Mac's registered JDKs, so either one of the range runs Gradle, or the
    // script fails; the java 27 on PATH may never run it.
    const bin = path.dirname(path.join(fakeJdk("27"), "bin/java"));
    const { status, output } = buildPhase({ PATH: `${bin}:${SYSTEM_PATH}` });
    if (status === 2) {
      assert.match(output, /java on PATH \(.*\) runs Java 27; set JAVA_HOME to a JDK of that range/);
      assert.doesNotMatch(output, /gradlew/);
      return;
    }
    assert.equal(status, 0, output);
    const javaHome = /gradlew JAVA_HOME=(\S*) /.exec(output)?.[1];
    assert.ok(javaHome, `Gradle ran on the java from PATH, which is Java 27:\n${output}`);
    const version = spawnSync(path.join(javaHome, "bin/java"), ["-version"], { encoding: "utf8" }).stderr;
    const major = Number(/version "(?:1\.)?(\d+)/.exec(version)?.[1]);
    assert.ok(major >= 17 && major <= 23, `java_home chose ${javaHome}, which runs Java ${major}`);
  });
});

describe("the JDK range", () => {
  const values = (script) => {
    const text = readFileSync(path.join(SCRIPTS, script), "utf8");
    return Object.fromEntries(
      ["java_gradle", "minimum_java", "maximum_java"].map((name) => {
        const found = [...text.matchAll(new RegExp(`^${name}=(\\S+)$`, "gm"))];
        assert.equal(found.length, 1, `${script} must assign ${name} exactly once`);
        return [name, found[0][1]];
      }),
    );
  };

  it("is the same in verify and kmp-framework, and is the one for the wrapper's Gradle version", () => {
    const verify = values("verify");
    assert.deepEqual(values("kmp-framework"), verify);
    const wrapper = /^distributionUrl=.*\/gradle-([0-9.]+)-[a-z]+\.zip$/m.exec(readFileSync(path.join(MOBILE, WRAPPER_PROPERTIES), "utf8"));
    assert.equal(wrapper?.[1], verify.java_gradle, "the wrapper pins another Gradle than the one the JDK range is for");
  });
});
