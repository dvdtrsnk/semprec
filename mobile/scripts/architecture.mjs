#!/usr/bin/env node
/**
 * Checks the rules of the mobile platform that Gradle, Tuist, Xcode and the compilers do not enforce on their
 * own: which module may depend on and import which, where platform APIs, the Kotlin framework and navigation
 * may appear, that every shared screen ViewModel is tested, bridged to Swift and hosted by an Android screen, the
 * screen folder layout, that both platforms carry the same copy keys with English and Czech text, and that the
 * Apple identity and the Gradle wrapper match their recorded values. The rule catalogue, with how to fix each
 * violation, is in mobile/docs/verify.md.
 *
 * Usage: `node mobile/scripts/architecture.mjs [<mobile directory>]`. The directory defaults to the `mobile/`
 * directory this file lives in, so the check runs the same from any working directory and through a symlinked
 * path. It prints one line per rule and one line per violation. It exits 1 when a rule is violated, when the
 * policy cannot be read and when it is given more than one argument.
 *
 * What the rules allow (module graphs, owners, copy keys) is `architecture-policy.json` next to this file. The
 * check reads source text, not a compiler model: imports, `project(...)` calls, Tuist target declarations and
 * class declarations are found with regular expressions and bracket matching over the code with its comments
 * removed. A Tuist target or dependency name it cannot resolve to a string is reported, not skipped.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const POLICY_FILE = "scripts/architecture-policy.json";

/** Directory names of build outputs, caches and generated projects; nothing below them is hand-written. */
const IGNORED_NAMES = new Set([
  ".build",
  ".gradle",
  ".idea",
  ".kotlin",
  ".swiftpm",
  "build",
  "Derived",
  "DerivedData",
  "node_modules",
  "xcuserdata",
]);

export function isIgnoredName(name) {
  return IGNORED_NAMES.has(name) || name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace");
}

export const RULES = [
  ["ARCH-GRADLE", "Gradle modules and their project dependencies follow the policy, without a cycle"],
  ["ARCH-APPLE", "Apple targets, their Tuist dependencies and their Swift imports follow the policy"],
  ["KMP-COMMON", "No platform import in commonMain"],
  ["KMP-FRAMEWORK", "Only the Kotlin framework target and the targets the policy allows import the Kotlin framework"],
  ["VM-BRIDGE", "Every shared screen ViewModel has a test, one CoreKit bridge that closes it, an Android screen"],
  ["NAV-OWNERSHIP", "Navigation libraries and controllers stay in the app modules and out of ViewModels"],
  ["APPLE-IDENTITY", "gradle/project.properties and ProjectConfiguration.swift agree"],
  ["ORG-SCREEN", "Screen folders hold their layout (Android) or their view (Apple)"],
  ["COPY-PARITY", "Android and Apple copy keys match the policy, each with a non-empty English and Czech value"],
  ["WRAPPER", "gradle-wrapper.jar matches its recorded SHA-256"],
].map(([id, summary]) => ({ id, summary }));

const PROPERTIES_FILE = "gradle/project.properties";
const APPLE_CONFIGURATION_FILE = "apple/Tuist/ProjectDescriptionHelpers/ProjectConfiguration.swift";
const WRAPPER_JAR = "gradle/wrapper/gradle-wrapper.jar";
const WRAPPER_CHECKSUM = "gradle/wrapper/gradle-wrapper.jar.sha256";
const PLATFORM_IMPORT_PREFIXES = ["android.", "androidx.", "java.", "javax.", "platform.", "kotlinx.cinterop."];
const IDENTITY_KEYS = ["appleBundleId", "frameworkName", "versionName", "versionCode", "iosMinimum", "macosMinimum"];
const NAVIGATION_TYPES = /\b(?:NavController|NavHostController)\b/g;
const NAVIGATION_KOTLIN_PACKAGE = "androidx.navigation.";
const NAVIGATION_SWIFT_MODULE = "NavigatorUI";

// ---------------------------------------------------------------------------------------------------------------
// Source text helpers

/** Index just past the string literal that starts at `start`; Swift `\(...)` and Kotlin `${...}` may nest strings. */
function skipString(text, start) {
  if (text.startsWith('"""', start)) {
    const end = text.indexOf('"""', start + 3);
    return end === -1 ? text.length : end + 3;
  }
  let i = start + 1;
  while (i < text.length && text[i] !== '"' && text[i] !== "\n") {
    if ((text[i] === "\\" && text[i + 1] === "(") || (text[i] === "$" && text[i + 1] === "{")) {
      const close = matchClose(text, i + 1);
      if (close === -1) return text.length;
      i = close + 1;
      continue;
    }
    if (text[i] === "\\") i += 1;
    i += 1;
  }
  return i + 1;
}

/** Index just past a Kotlin character literal ('a', '\n', '"') at `start`, or `start` when there is none. */
function skipCharacter(text, start) {
  const match = /'(?:\\.[^'\n]*|[^'\\\n])'/y;
  match.lastIndex = start;
  return match.test(text) ? match.lastIndex : start;
}

/** Index of the bracket that closes the one at `open`, skipping string literals; -1 when it is never closed. */
function matchClose(text, open) {
  const closing = { "(": ")", "[": "]", "{": "}" };
  const expected = [];
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      i = skipString(text, i) - 1;
    } else if (c === "'") {
      i = Math.max(i, skipCharacter(text, i) - 1);
    } else if (closing[c]) {
      expected.push(closing[c]);
    } else if (c === ")" || c === "]" || c === "}") {
      if (expected.pop() !== c) return -1;
      if (expected.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Replaces every `//` and (nested) `/* *\/` comment of Kotlin, Swift or Gradle Kotlin script code with spaces,
 * keeping string literals and line breaks, so indices and line numbers stay those of the original text.
 */
function stripComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (text.startsWith("/*", i)) {
      let depth = 0;
      const start = i;
      while (i < text.length) {
        if (text.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else {
          i += 1;
        }
      }
      out += text.slice(start, i).replace(/[^\n]/g, " ");
    } else if (text[i] === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text[i] === "'") {
      const end = Math.max(i + 1, skipCharacter(text, i));
      out += text.slice(i, end);
      i = end;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** The arguments between `start` and `end` split at top-level commas, each with its `label:` if it has one. */
function splitArguments(code, start, end) {
  const parts = [];
  let from = start;
  for (let i = start; i <= end; i += 1) {
    const c = code[i];
    if (i === end || c === ",") {
      const raw = code.slice(from, i);
      if (raw.trim()) {
        const label = /^\s*(\w+)\s*:(?!:)/.exec(raw);
        parts.push({ label: label ? label[1] : null, value: label ? raw.slice(label[0].length).trim() : raw.trim() });
      }
      from = i + 1;
    } else if (c === '"') {
      i = skipString(code, i) - 1;
    } else if (c === "(" || c === "[" || c === "{") {
      const close = matchClose(code, i);
      i = close === -1 ? end : close;
    }
  }
  return parts;
}

function kotlinImports(code) {
  return [...code.matchAll(/^[ \t]*import[ \t]+([\w.`]+)/gm)].map((m) => ({
    name: m[1].replaceAll("`", ""),
    index: m.index,
  }));
}

const SWIFT_IMPORT =
  /^[ \t]*(?:@\w+(?:\([^)\n]*\))?[ \t]+)*(?:(?:public|package|internal|fileprivate|private)[ \t]+)?import[ \t]+(?:(?:typealias|struct|class|enum|protocol|let|var|func)[ \t]+)?(\w+)/gm;

function swiftImports(code) {
  return [...code.matchAll(SWIFT_IMPORT)].map((m) => ({ module: m[1], index: m.index }));
}

/**
 * Every Kotlin `class` with the simple names of its supertypes: the header after the name, its type parameters
 * and its primary constructor, up to the body's `{` or the end of the declaration.
 */
function kotlinClasses(code) {
  const classes = [];
  for (const m of code.matchAll(/\bclass\s+(\w+)/g)) {
    const lineStart = code.lastIndexOf("\n", m.index) + 1;
    const abstract = /\babstract\b/.test(code.slice(lineStart, m.index));
    let i = m.index + m[0].length;
    const typeParameters = /^\s*</.exec(code.slice(i));
    if (typeParameters) {
      let depth = 0;
      for (i += typeParameters[0].length - 1; i < code.length; i += 1) {
        if (code[i] === "<") depth += 1;
        else if (code[i] === ">" && (depth -= 1) === 0) break;
      }
      i += 1;
    }
    i += /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:private|protected|internal|public)\s+)?(?:constructor\s*)?/.exec(
      code.slice(i),
    )[0].length;
    if (code[i] === "(") {
      const close = matchClose(code, i);
      if (close === -1) continue;
      i = close + 1;
    }
    const colon = /^\s*:/.exec(code.slice(i));
    const supertypes = [];
    if (colon) {
      i += colon[0].length;
      let depth = 0;
      let header = "";
      for (; i < code.length; i += 1) {
        const c = code[i];
        if (depth === 0 && c === "{") break;
        if (depth === 0 && c === "\n" && header.trim() && !/[,:]\s*$/.test(header)) break;
        if (c === "(" || c === "<") depth += 1;
        if (c === ")" || c === ">") depth -= 1;
        header += depth === 0 && c === "," ? "\u0000" : c;
      }
      for (const entry of header.split("\u0000")) {
        const name = /^\s*([\w.]+)/.exec(entry);
        if (name) supertypes.push(name[1].split(".").pop());
      }
    }
    classes.push({ name: m[1], index: m.index, abstract, supertypes });
  }
  return classes;
}

/**
 * The names of the `classes` (each `{ name, supertypes }`, as kotlinClasses reads them) that extend one of `roots`,
 * directly or through other classes among `classes`. Names are simple names, so a supertype declared outside
 * `classes` ends its branch of the chain. The set grows until no class adds a name, which also ends a cycle the
 * compiler would reject instead of following it forever.
 */
function subclassNames(classes, roots) {
  const rootNames = new Set(roots);
  const found = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, supertypes } of classes) {
      if (!found.has(name) && supertypes.some((type) => rootNames.has(type) || found.has(type))) {
        found.add(name);
        grew = true;
      }
    }
  }
  return found;
}

/** Every Swift `class` with its body, from its `{` to the matching `}`. */
function swiftClasses(code) {
  const classes = [];
  for (const m of code.matchAll(/\bclass\s+(?!func\b|var\b|let\b|subscript\b)(\w+)/g)) {
    const open = code.indexOf("{", m.index + m[0].length);
    if (open === -1) continue;
    const close = matchClose(code, open);
    classes.push({ name: m[1], index: m.index, body: code.slice(open, close === -1 ? code.length : close + 1) });
  }
  return classes;
}

function readProperties(text) {
  const values = new Map();
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    const separator = trimmed.search(/[=:]/);
    if (separator > 0) values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }
  return values;
}

/** Gradle project path to its directory below the mobile root (`:android:core:ui` → `android/core/ui`). */
function moduleDirectory(module) {
  return module.slice(1).split(":").join("/");
}

function list(values) {
  return values.length ? values.join(", ") : "none";
}

function findCycle(graph) {
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, "active");
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (state.get(next) === "active") return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of graph.keys()) {
    if (!state.has(node)) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The tree

class Tree {
  constructor(root) {
    this.root = root;
    this.texts = new Map();
    this.codes = new Map();
  }

  /** The file's text, or null when it does not exist. `rel` is relative to the mobile root, with `/`. */
  text(rel) {
    if (!this.texts.has(rel)) {
      const file = path.join(this.root, rel);
      this.texts.set(rel, existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : null);
    }
    return this.texts.get(rel);
  }

  /** The file's code with comments removed, or null when it does not exist. */
  code(rel) {
    if (!this.codes.has(rel)) {
      const text = this.text(rel);
      this.codes.set(rel, text === null ? null : stripComments(text));
    }
    return this.codes.get(rel);
  }

  exists(rel) {
    return existsSync(path.join(this.root, rel));
  }

  /** Every file and directory below `rel`, depth first and sorted, without ignored directories. */
  entries(rel) {
    const found = [];
    const walk = (dir) => {
      let names;
      try {
        names = readdirSync(path.join(this.root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (isIgnoredName(entry.name)) continue;
          found.push({ path: child, directory: true });
          walk(child);
        } else if (entry.isFile()) {
          found.push({ path: child, directory: false });
        }
      }
    };
    walk(rel);
    return found;
  }

  files(rel, extension) {
    return this.entries(rel)
      .filter((entry) => !entry.directory && entry.path.endsWith(extension))
      .map((entry) => entry.path);
  }

  directories(rel) {
    return this.entries(rel)
      .filter((entry) => entry.directory)
      .map((entry) => entry.path);
  }

  /** The names of the files directly inside `rel`. */
  children(rel) {
    return this.#names(rel, (entry) => entry.isFile());
  }

  /** The names of the directories directly inside `rel`, without ignored ones. */
  subdirectories(rel) {
    return this.#names(rel, (entry) => entry.isDirectory() && !isIgnoredName(entry.name));
  }

  /** Sorted names of the entries directly inside `rel` that `keep` accepts; none when `rel` is no directory. */
  #names(rel, keep) {
    let entries;
    try {
      entries = readdirSync(path.join(this.root, rel), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    }
    return entries
      .filter(keep)
      .map((entry) => entry.name)
      .sort();
  }
}

function violation(rule, file, line, message) {
  return { rule, file, line, message };
}

// ---------------------------------------------------------------------------------------------------------------
// Shared facts read once for all rules

function readPolicy(root) {
  const file = path.join(root, POLICY_FILE);
  let policy;
  try {
    policy = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${POLICY_FILE}: ${error.message}`);
  }
  const missing = [
    ["gradle.modules", policy?.gradle?.modules],
    ["kotlinCommon.allowedImports", policy?.kotlinCommon?.allowedImports],
    ["apple.systemModules", policy?.apple?.systemModules],
    ["apple.externalModules", policy?.apple?.externalModules],
    ["apple.kotlinFrameworkTarget", policy?.apple?.targets?.[policy?.apple?.kotlinFrameworkTarget]],
    ["apple.targets", policy?.apple?.targets],
    ["viewModels", policy?.viewModels?.module && policy.viewModels.baseClass && policy.viewModels.leaseType],
    ["navigation", policy?.navigation?.gradleModules && policy.navigation.appleTargets],
    ["copy", Array.isArray(policy?.copy) ? policy.copy : null],
  ].filter(([, value]) => !value);
  if (missing.length) throw new Error(`${POLICY_FILE} lacks ${missing.map(([key]) => key).join(", ")}`);
  return policy;
}

function gradleIncludes(tree) {
  const code = tree.code("settings.gradle.kts") ?? "";
  const includes = [];
  for (const call of code.matchAll(/\binclude\s*\(([^)]*)\)/g)) {
    for (const module of call[1].matchAll(/"(:[^"\s]+)"/g)) {
      includes.push({ module: module[1], line: lineAt(code, call.index + call[0].indexOf(module[0])) });
    }
  }
  return includes;
}

function appleConfiguration(tree) {
  const code = tree.code(APPLE_CONFIGURATION_FILE) ?? "";
  const values = new Map();
  for (const m of code.matchAll(/\bstatic\s+let\s+(\w+)\s*(?::\s*\w+\s*)?=\s*"([^"\\]*)"/g)) {
    values.set(m[1], { value: m[2], line: lineAt(code, m.index) });
  }
  return values;
}

/**
 * The targets a Tuist `Project.swift` declares, each with its dependencies. Declarations are
 * `SemprecProject.framework(<name>, …)`, `SemprecProject.tests(<name>, for: <host>, …)` and Tuist's
 * `.target(name:…, product:…)`; dependencies are `.project(target:path:)`, `.target(name:)` and `.external(name:)`
 * inside them, plus the host of a `tests` target, which `SemprecProject.tests` adds as `.target(name:)`
 * (apple/Tuist/ProjectDescriptionHelpers/SemprecProject.swift). A `.target` also carries the entries of its
 * `sources:` argument, a string or an array of strings, each relative to the project; the helpers compile
 * `Sources/**` or `Tests/**` and carry none. Names and paths are string literals, `\(…)` interpolations and `let`
 * aliases of `ProjectConfiguration` values.
 */
function parseManifest(code, configuration) {
  const aliases = new Map();
  for (const m of code.matchAll(/\blet\s+(\w+)\s*=\s*ProjectConfiguration\.(\w+)\b/g)) {
    aliases.set(m[1], configuration.get(m[2])?.value);
  }
  const identifier = (name) =>
    name.startsWith("ProjectConfiguration.") ? configuration.get(name.slice(21))?.value : aliases.get(name);
  const resolve = (expression) => {
    const literal = /^"((?:[^"\\]|\\.)*)"$/.exec(expression);
    if (literal) {
      let resolved = true;
      const value = literal[1].replace(/\\\(([\w.]+)\)/g, (_, name) => {
        const part = identifier(name);
        if (part === undefined) resolved = false;
        return part ?? "";
      });
      return resolved && !value.includes("\\") ? value : null;
    }
    return /^[\w.]+$/.test(expression) ? (identifier(expression) ?? null) : null;
  };
  const argument = (args, label) => args.find((a) => a.label === label)?.value;

  const targets = [];
  for (const m of code.matchAll(/(SemprecProject\.framework|SemprecProject\.tests|\.target)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(code, open);
    if (close === -1) continue;
    const args = splitArguments(code, open + 1, close);
    const declaration = m[1];
    if (declaration === ".target" && !args.some((a) => a.label === "product")) continue;
    const nameExpression = declaration === ".target" ? argument(args, "name") : args.find((a) => !a.label)?.value;
    const target = {
      expression: nameExpression ?? "",
      name: nameExpression ? resolve(nameExpression) : null,
      line: lineAt(code, m.index),
      dependencies: [],
      sources: [],
    };
    const sources = declaration === ".target" ? argument(args, "sources") : undefined;
    if (sources !== undefined) {
      const array = /^\[([\s\S]*)\]$/.exec(sources);
      const entries = array ? splitArguments(array[1], 0, array[1].length).map((entry) => entry.value) : [sources];
      let cursor = open;
      for (const expression of entries) {
        const index = code.indexOf(expression, cursor);
        cursor = index + expression.length;
        target.sources.push({ expression, path: resolve(expression), line: lineAt(code, index) });
      }
    }
    if (declaration === "SemprecProject.tests") {
      const host = argument(args, "for") ?? "";
      target.dependencies.push({ kind: "target", expression: host, name: resolve(host), line: target.line });
    }
    const body = code.slice(open + 1, close);
    for (const dependency of body.matchAll(/\.(project|target|external)\s*\(/g)) {
      const start = open + 1 + dependency.index + dependency[0].length - 1;
      const end = matchClose(code, start);
      if (end === -1) continue;
      const dependencyArgs = splitArguments(code, start + 1, end);
      const kind = dependency[1];
      const expression = (kind === "project" ? argument(dependencyArgs, "target") : argument(dependencyArgs, "name")) ?? "";
      const pathExpression = kind === "project" ? (argument(dependencyArgs, "path") ?? "") : null;
      target.dependencies.push({
        kind,
        expression,
        name: resolve(expression),
        path: pathExpression === null ? null : resolve(pathExpression),
        pathExpression,
        line: lineAt(code, start),
      });
    }
    targets.push(target);
  }
  return targets;
}

function context(root) {
  const policy = readPolicy(root);
  const tree = new Tree(root);
  const includes = gradleIncludes(tree);
  const modules = [...new Set(includes.map((include) => include.module))];
  const properties = readProperties(tree.text(PROPERTIES_FILE));
  const configuration = appleConfiguration(tree);
  const appleTargets = new Map(Object.entries(policy.apple.targets));
  const kotlinFiles = (module, sourceSet = "") =>
    tree.files(`${moduleDirectory(module)}/src${sourceSet ? `/${sourceSet}` : ""}`, ".kt");
  const appleSources = (target) => {
    const spec = appleTargets.get(target);
    return `apple/${spec.project}/${spec.sources}`;
  };
  return { root, policy, tree, includes, modules, properties, configuration, appleTargets, kotlinFiles, appleSources };
}

// ---------------------------------------------------------------------------------------------------------------
// Rules

function checkGradle(ctx) {
  const rule = "ARCH-GRADLE";
  const found = [];
  const allowedByModule = ctx.policy.gradle.modules;
  for (const { module, line } of ctx.includes) {
    if (!Object.hasOwn(allowedByModule, module)) {
      found.push(violation(rule, "settings.gradle.kts", line, `includes ${module}, which has no entry in gradle.modules of ${POLICY_FILE}`));
    }
  }
  for (const module of Object.keys(allowedByModule)) {
    if (!ctx.modules.includes(module)) {
      found.push(violation(rule, POLICY_FILE, null, `gradle.modules lists ${module}, which settings.gradle.kts does not include`));
    }
  }
  const graph = new Map();
  for (const module of ctx.modules) {
    const file = `${moduleDirectory(module)}/build.gradle.kts`;
    const code = ctx.tree.code(file) ?? "";
    const dependencies = [...code.matchAll(/\bproject\(\s*(?:path\s*=\s*)?"(:[^"\s]+)"\s*\)/g)];
    graph.set(module, [...new Set(dependencies.map((m) => m[1]))]);
    const allowed = allowedByModule[module];
    if (!allowed) continue;
    for (const m of dependencies) {
      if (!allowed.includes(m[1])) {
        found.push(violation(rule, file, lineAt(code, m.index), `${module} depends on ${m[1]}, which gradle.modules does not allow (allowed: ${list(allowed)})`));
      }
    }
  }
  const cycle = findCycle(graph);
  if (cycle) {
    found.push(violation(rule, `${moduleDirectory(cycle[0])}/build.gradle.kts`, null, `dependency cycle ${cycle.join(" -> ")}`));
  }
  return found;
}

/**
 * A target's `allowed` list names what it may depend on and import. A UI test target names its app in
 * `appUnderTest` instead: it depends on the app, which Tuist turns into the application the tests launch, but it
 * drives the app from outside, through the accessibility tree, so it may not import the app or any module of it.
 * A target's imports are those of the Swift files below its `sources` directory, plus those of every single Swift
 * file its manifest's `sources:` adds from elsewhere (the UI tests compile the identifier files of the app and the
 * features); a `sources:` glob outside its directory is reported, since the imports below it would go unchecked.
 */
function checkApple(ctx) {
  const rule = "ARCH-APPLE";
  const found = [];
  const { appleTargets } = ctx;
  const apple = ctx.policy.apple;
  const system = new Set(apple.systemModules);
  const externals = new Set(apple.externalModules);
  const framework = ctx.properties.get("frameworkName");
  const isAppUnderTest = (spec, dependency) => dependency.kind !== "external" && dependency.name === spec.appUnderTest;

  for (const [name, spec] of appleTargets) {
    if (spec.appUnderTest !== undefined && !appleTargets.has(spec.appUnderTest)) {
      found.push(violation(rule, POLICY_FILE, null, `apple.targets.${name}.appUnderTest is ${JSON.stringify(spec.appUnderTest)}, which apple.targets does not list`));
    }
  }

  const declared = new Map();
  const manifests = ctx.tree
    .files("apple", "/Project.swift")
    .filter((file) => !file.startsWith("apple/Tuist/"));
  for (const manifest of manifests) {
    const project = manifest.slice("apple/".length, -"/Project.swift".length);
    for (const target of parseManifest(ctx.tree.code(manifest), ctx.configuration)) {
      if (target.name === null) {
        found.push(violation(rule, manifest, target.line, `cannot resolve the target name ${target.expression || "(missing)"} to a string`));
        continue;
      }
      declared.set(target.name, { ...target, manifest, project, extraSources: [] });
      const spec = appleTargets.get(target.name);
      if (!spec) {
        found.push(violation(rule, manifest, target.line, `declares target ${target.name}, which has no entry in apple.targets of ${POLICY_FILE}`));
        continue;
      }
      if (spec.project !== project) {
        found.push(violation(rule, manifest, target.line, `declares target ${target.name}, which apple.targets places in ${spec.project}`));
      }
      for (const dependency of target.dependencies) {
        const shown = `.${dependency.kind}(${dependency.expression})`;
        if (dependency.name === null) {
          found.push(violation(rule, manifest, dependency.line, `${target.name}: cannot resolve the dependency ${shown} to a string`));
          continue;
        }
        if (dependency.kind === "external") {
          if (!externals.has(dependency.name)) {
            found.push(violation(rule, manifest, dependency.line, `${target.name} depends on external ${dependency.name}, which apple.externalModules does not list`));
          }
        } else {
          const other = appleTargets.get(dependency.name);
          const expected = dependency.kind === "target" ? project : dependency.path === null ? null : path.posix.normalize(path.posix.join(project, dependency.path));
          if (!other) {
            found.push(violation(rule, manifest, dependency.line, `${target.name} depends on ${dependency.name}, which apple.targets does not list`));
            continue;
          }
          if (expected !== other.project) {
            const where = dependency.kind === "target" ? "this project" : `path ${dependency.pathExpression}`;
            found.push(violation(rule, manifest, dependency.line, `${target.name} depends on ${dependency.name} in ${where}, but apple.targets places it in ${other.project}`));
          }
        }
        if (!spec.allowed.includes(dependency.name) && !isAppUnderTest(spec, dependency)) {
          found.push(violation(rule, manifest, dependency.line, `${target.name} depends on ${dependency.name}, which apple.targets.${target.name}.allowed does not list (allowed: ${list(spec.allowed)})`));
        }
      }
      if (spec.appUnderTest !== undefined && !target.dependencies.some((dependency) => isAppUnderTest(spec, dependency))) {
        found.push(violation(rule, manifest, target.line, `${target.name} does not depend on ${spec.appUnderTest}, its apple.targets.${target.name}.appUnderTest, so it has no app to launch`));
      }
      const ownSources = `apple/${spec.project}/${spec.sources}/`;
      for (const source of target.sources) {
        if (source.path === null) {
          found.push(violation(rule, manifest, source.line, `${target.name}: cannot resolve the source ${source.expression} to a path`));
          continue;
        }
        const file = path.posix.normalize(path.posix.join("apple", project, source.path));
        if (file.startsWith(ownSources)) continue;
        if (!file.endsWith(".swift") || /[*?[{]/.test(file)) {
          found.push(violation(rule, manifest, source.line, `${target.name} compiles ${source.path}, which is neither below its apple.targets.${target.name}.sources (${spec.sources}) nor one Swift file, so its imports would go unchecked`));
        } else if (ctx.tree.code(file) === null) {
          found.push(violation(rule, manifest, source.line, `${target.name} compiles ${source.path}, which does not exist`));
        } else {
          declared.get(target.name).extraSources.push(file);
        }
      }
    }
  }
  for (const [name, spec] of appleTargets) {
    if (!declared.has(name)) {
      found.push(violation(rule, POLICY_FILE, null, `apple.targets lists ${name}, which no Project.swift in apple/${spec.project} declares`));
    }
  }

  for (const [name, spec] of appleTargets) {
    const target = declared.get(name);
    const dependencies = new Set((target?.dependencies ?? []).map((dependency) => dependency.name));
    const extraSources = new Set(target?.extraSources ?? []);
    for (const file of [...ctx.tree.files(ctx.appleSources(name), ".swift"), ...extraSources]) {
      const code = ctx.tree.code(file);
      for (const { module, index } of swiftImports(code)) {
        if (system.has(module) || module === name) continue;
        const line = lineAt(code, index);
        // KMP-FRAMEWORK checks the framework imports of each file by its directory; a file another target's
        // directory holds is checked here against the target that borrows it.
        if (module === framework) {
          if (extraSources.has(file) && name !== apple.kotlinFrameworkTarget && !spec.allowed.includes(framework)) {
            found.push(violation(rule, file, line, `${name} compiles this file, which imports the Kotlin framework ${framework}; apple.targets.${name}.allowed does not list it`));
          }
          continue;
        }
        if (!appleTargets.has(module) && !externals.has(module)) {
          found.push(violation(rule, file, line, `${name} imports ${module}, which is no system module, target or external module of ${POLICY_FILE} (apple.systemModules, apple.targets, apple.externalModules)`));
          continue;
        }
        if (!spec.allowed.includes(module)) {
          const appUnderTest = module === spec.appUnderTest ? `; ${module} is its appUnderTest, which a UI test drives from outside and never imports` : "";
          found.push(violation(rule, file, line, `${name} imports ${module}, which apple.targets.${name}.allowed does not list (allowed: ${list(spec.allowed)})${appUnderTest}`));
        }
        if (target && !dependencies.has(module)) {
          found.push(violation(rule, file, line, `${name} imports ${module} without declaring it as a dependency in ${target.manifest}; Xcode builds such an import only by accident of the workspace`));
        }
      }
    }
  }
  return found;
}

function checkKmpCommon(ctx) {
  const rule = "KMP-COMMON";
  const found = [];
  const allowed = new Set(ctx.policy.kotlinCommon.allowedImports);
  for (const module of ctx.modules) {
    for (const file of ctx.kotlinFiles(module, "commonMain")) {
      const code = ctx.tree.code(file);
      for (const { name, index } of kotlinImports(code)) {
        if (PLATFORM_IMPORT_PREFIXES.some((prefix) => name.startsWith(prefix)) && !allowed.has(name)) {
          found.push(violation(rule, file, lineAt(code, index), `imports the platform API ${name} in commonMain (kotlinCommon.allowedImports: ${list([...allowed])})`));
        }
      }
    }
  }
  return found;
}

function checkKmpFramework(ctx) {
  const rule = "KMP-FRAMEWORK";
  const framework = ctx.properties.get("frameworkName");
  if (!framework) {
    return [violation(rule, PROPERTIES_FILE, null, "has no frameworkName, so the imports of the Kotlin framework cannot be checked")];
  }
  // The framework target imports the framework; another target only when its apple.targets entry lists the
  // framework in `allowed` (CoreKitTests, whose tests drive CoreKit's bridges with Kotlin values).
  const owner = ctx.policy.apple.kotlinFrameworkTarget;
  const importers = [...ctx.appleTargets]
    .filter(([name, spec]) => name === owner || spec.allowed.includes(framework))
    .map(([name]) => name);
  const allowedDirectories = importers.map((name) => `${ctx.appleSources(name)}/`);
  const found = [];
  for (const file of ctx.tree.files("apple", ".swift")) {
    if (allowedDirectories.some((directory) => file.startsWith(directory))) continue;
    const code = ctx.tree.code(file);
    for (const { module, index } of swiftImports(code)) {
      if (module === framework) {
        found.push(violation(rule, file, lineAt(code, index), `imports ${framework}; only the sources of ${importers.join(" and ")} (${allowedDirectories.join(", ")}) import the Kotlin framework, everything else uses ${owner}'s Swift types`));
      }
    }
  }
  return found;
}

function checkViewModelBridges(ctx) {
  const rule = "VM-BRIDGE";
  const found = [];
  const { module, baseClass, leaseType } = ctx.policy.viewModels;

  // A screen ViewModel extends the base class directly or through classes of the same module (an abstract
  // `ListViewModel : ScreenViewModel` and a concrete `ProfileViewModel : ListViewModel`); the concrete ones are hosted.
  const classes = ctx.kotlinFiles(module, "commonMain").flatMap((file) => {
    const code = ctx.tree.code(file);
    return kotlinClasses(code).map((declared) => ({ ...declared, file, line: lineAt(code, declared.index) }));
  });
  const screenViewModelNames = subclassNames(classes, [baseClass]);
  const viewModels = classes.filter((declared) => !declared.abstract && screenViewModelNames.has(declared.name));

  const tests = ctx.kotlinFiles(module, "commonTest");
  const screens = [];
  for (const gradleModule of ctx.modules) {
    for (const file of ctx.kotlinFiles(gradleModule, "main").filter((f) => f.endsWith("Screen.kt"))) {
      const code = ctx.tree.code(file);
      for (const m of code.matchAll(/\bfun\s+(\w+Screen)\s*\(/g)) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(code, open);
        if (close !== -1) screens.push({ name: m[1], file, parameters: code.slice(open + 1, close) });
      }
    }
  }
  const owner = ctx.policy.apple.kotlinFrameworkTarget;
  const bridgeClasses = ctx.tree.files(ctx.appleSources(owner), ".swift").flatMap((file) => {
    const code = ctx.tree.code(file);
    return swiftClasses(code).map((declared) => ({ ...declared, file, line: lineAt(code, declared.index) }));
  });
  // The Kotlin types are module-qualified in CoreKit (`SharedSDK.HomeViewModel`) where a Swift name could clash.
  const storedType = (body, type) => new RegExp(`\\b(?:let|var)\\s+\\w+\\s*:\\s*(?:\\w+\\.)?${type}\\b`).test(body);

  for (const viewModel of viewModels) {
    const where = [viewModel.file, viewModel.line];
    if (!tests.some((file) => path.posix.basename(file) === `${viewModel.name}Test.kt`)) {
      found.push(violation(rule, ...where, `${viewModel.name} has no ${viewModel.name}Test.kt in ${moduleDirectory(module)}/src/commonTest`));
    }
    const bridges = bridgeClasses.filter((declared) => storedType(declared.body, viewModel.name));
    if (bridges.length !== 1) {
      const names = bridges.map((bridge) => `${bridge.name} (${bridge.file}:${bridge.line})`);
      found.push(violation(rule, ...where, `${viewModel.name} has ${bridges.length} ${owner} bridges, exactly one must store it${names.length ? `: ${names.join(", ")}` : ""}`));
    }
    const typed = new RegExp(`:\\s*(?:[\\w.]+\\.)?${viewModel.name}\\b`);
    if (!screens.some((screen) => typed.test(screen.parameters))) {
      found.push(violation(rule, ...where, `no Android *Screen composable takes ${viewModel.name} as a parameter`));
    }
  }

  // A CoreKit class holding any shared ViewModel type, the abstract ones and the base class included, owns a lease.
  const viewModelNames = [baseClass, ...screenViewModelNames];
  for (const declared of bridgeClasses) {
    const storesViewModel = viewModelNames.some((name) => storedType(declared.body, name));
    const leases = [...declared.body.matchAll(new RegExp(`\\b(?:let|var)\\s+(\\w+)\\s*:\\s*${leaseType}\\b`, "g"))].map((m) => m[1]);
    if (!storesViewModel && leases.length === 0) continue;
    if (leases.length === 0) {
      found.push(violation(rule, declared.file, declared.line, `${declared.name} stores a shared ViewModel but no ${leaseType}`));
      continue;
    }
    const deinit = /\bdeinit\s*\{/.exec(declared.body);
    const deinitClose = deinit ? matchClose(declared.body, deinit.index + deinit[0].length - 1) : -1;
    const deinitBody = deinit ? declared.body.slice(deinit.index, deinitClose === -1 ? undefined : deinitClose) : "";
    for (const lease of leases) {
      if (!new RegExp(`\\b${lease}\\s*\\.\\s*close\\s*\\(\\s*\\)`).test(deinitBody)) {
        found.push(violation(rule, declared.file, declared.line, `${declared.name} does not call ${lease}.close() in deinit, so releasing it never closes the shared ViewModel`));
      }
    }
  }
  return found;
}

function checkNavigation(ctx) {
  const rule = "NAV-OWNERSHIP";
  const found = [];
  const { gradleModules, appleTargets: owners } = ctx.policy.navigation;
  // A ViewModel extends AndroidX's ViewModel or the shared base class, directly or through classes declared in any
  // module (the presentation module's abstract screen ViewModels, an app module's own base class).
  const roots = ["ViewModel", ctx.policy.viewModels.baseClass];
  const classesByFile = new Map(
    ctx.modules.flatMap((module) => ctx.kotlinFiles(module).map((file) => [file, kotlinClasses(ctx.tree.code(file))])),
  );
  const viewModelTypes = new Set([...roots, ...subclassNames([...classesByFile.values()].flat(), roots)]);
  for (const module of ctx.modules) {
    const owner = gradleModules.includes(module);
    for (const file of ctx.kotlinFiles(module)) {
      const code = ctx.tree.code(file);
      const viewModel =
        file.endsWith("ViewModel.kt") ||
        classesByFile.get(file).some((c) => c.supertypes.some((type) => viewModelTypes.has(type)));
      if (owner && !viewModel) continue;
      const place = viewModel ? "a ViewModel" : `${module}, which navigation.gradleModules does not list`;
      const importLines = new Set();
      for (const { name, index } of kotlinImports(code)) {
        importLines.add(lineAt(code, index));
        if (name.startsWith(NAVIGATION_KOTLIN_PACKAGE)) {
          found.push(violation(rule, file, lineAt(code, index), `imports ${name} in ${place}`));
        }
      }
      const reported = new Set();
      for (const m of code.matchAll(NAVIGATION_TYPES)) {
        const line = lineAt(code, m.index);
        if (importLines.has(line) || reported.has(line)) continue;
        reported.add(line);
        found.push(violation(rule, file, line, `uses ${m[0]} in ${place}`));
      }
    }
  }
  for (const target of ctx.appleTargets.keys()) {
    const owner = owners.includes(target);
    for (const file of ctx.tree.files(ctx.appleSources(target), ".swift")) {
      const viewModel = file.endsWith("ViewModel.swift");
      if (owner && !viewModel) continue;
      const code = ctx.tree.code(file);
      for (const { module, index } of swiftImports(code)) {
        if (module === NAVIGATION_SWIFT_MODULE) {
          const place = viewModel ? "a ViewModel" : `${target}, which navigation.appleTargets does not list`;
          found.push(violation(rule, file, lineAt(code, index), `imports ${module} in ${place}`));
        }
      }
    }
  }
  return found;
}

function checkAppleIdentity(ctx) {
  const rule = "APPLE-IDENTITY";
  const found = [];
  for (const key of IDENTITY_KEYS) {
    const gradle = ctx.properties.get(key);
    const apple = ctx.configuration.get(key);
    if (gradle === undefined) found.push(violation(rule, PROPERTIES_FILE, null, `has no ${key}`));
    if (apple === undefined) found.push(violation(rule, APPLE_CONFIGURATION_FILE, null, `has no static let ${key}`));
    if (gradle !== undefined && apple !== undefined && gradle !== apple.value) {
      found.push(violation(rule, APPLE_CONFIGURATION_FILE, apple.line, `${key} is "${apple.value}", but ${PROPERTIES_FILE} has "${gradle}"`));
    }
  }
  return found;
}

function checkScreenFolders(ctx) {
  const rule = "ORG-SCREEN";
  const found = [];
  for (const module of ctx.modules) {
    const screenRoots = ctx.tree
      .directories(`${moduleDirectory(module)}/src`)
      .filter((dir) => dir.endsWith("/presentation/screen"));
    for (const screenRoot of screenRoots) {
      for (const folder of ctx.tree.directories(screenRoot).filter((dir) => path.posix.dirname(dir) === screenRoot)) {
        const names = ctx.tree.children(folder);
        for (const screen of names.filter((name) => name.endsWith("Screen.kt"))) {
          const layout = screen.replace(/\.kt$/, "Layout.kt");
          if (!names.includes(layout)) {
            found.push(violation(rule, `${folder}/${screen}`, null, `has no ${layout} next to it; a screen's stateless layout lives in its own file in the screen's folder`));
          }
        }
      }
    }
  }
  for (const target of ctx.appleTargets.keys()) {
    const screenRoots = ctx.tree.directories(ctx.appleSources(target)).filter((dir) => dir.endsWith("/Screens"));
    for (const screenRoot of screenRoots) {
      for (const folder of ctx.tree.directories(screenRoot).filter((dir) => path.posix.dirname(dir) === screenRoot)) {
        const names = ctx.tree.children(folder);
        for (const viewModel of names.filter((name) => /^\w+ViewModel\.swift$/.test(name))) {
          const screen = viewModel.replace(/ViewModel\.swift$/, "Screen.swift");
          if (!names.includes(screen)) {
            found.push(violation(rule, `${folder}/${viewModel}`, null, `has no ${screen} next to it; a screen folder with a ViewModel holds the screen's view`));
          }
        }
      }
    }
  }
  return found;
}

/**
 * Whether an Android string resource text shows nothing: empty, only whitespace or markup, or a quoted empty string
 * (`""`), which Android unquotes to nothing.
 */
function blankAndroidText(raw) {
  const text = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .trim();
  return text === "" || /^"\s*"$/.test(text);
}

/**
 * The string resources of every XML file in `dir` (an Android `values` or `values-*` directory), each with whether
 * it is translatable and whether it is blank: a `<string>` whose text is blank, a `<plurals>` or `<string-array>`
 * without items or with a blank item.
 */
function androidStrings(tree, dir) {
  const strings = new Map();
  for (const file of tree.files(dir, ".xml").filter((f) => path.posix.dirname(f) === dir)) {
    const text = tree.text(file).replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, " "));
    for (const m of text.matchAll(/<(string-array|plurals|string)\b([^>]*?)(\/?)>/g)) {
      const name = /\bname\s*=\s*"([^"]+)"/.exec(m[2]);
      if (!name) continue;
      const start = m.index + m[0].length;
      const close = m[3] ? -1 : text.indexOf(`</${m[1]}>`, start);
      const body = close === -1 ? "" : text.slice(start, close);
      const texts =
        m[1] === "string" ? [body] : [...body.matchAll(/<item\b[^>]*?(?:\/>|>([\s\S]*?)<\/item>)/g)].map((item) => item[1] ?? "");
      strings.set(name[1], {
        file,
        line: lineAt(text, m.index),
        translatable: !/\btranslatable\s*=\s*"false"/.test(m[2]),
        blank: texts.length === 0 || texts.some(blankAndroidText),
      });
    }
  }
  return strings;
}

/**
 * Whether a source set holds tests and never ships: one camelCase word of its name is "test" (`test`, `testDebug`,
 * `testFixtures`, `androidTest`, `androidUnitTest`, `androidInstrumentedTest`, `commonTest`, `iosSimulatorArm64Test`).
 */
function isTestSourceSet(name) {
  return name.split(/(?=[A-Z])/).some((word) => word.toLowerCase() === "test");
}

/**
 * The Android resource directories `src/<sourceSet>/res` of a Gradle module outside its test source sets. AGP
 * compiles `src/main/res` and the `res` of every build variant's source set (`debug`, `release`, ...); in a Kotlin
 * Multiplatform module (one with `src/commonMain`) also the `res` of each Android Kotlin source set (`androidMain`,
 * `androidDebug`, ...). `everyBuild` marks the source sets every build of the module compiles, `main` and, in a
 * Kotlin Multiplatform module, `androidMain`: copy lives only there, never in a variant's source set, so every build
 * carries the same copy as the Apple app.
 */
function androidResourceDirectories(tree, module) {
  const src = `${moduleDirectory(module)}/src`;
  const sourceSets = tree.subdirectories(src);
  const everyBuild = sourceSets.includes("commonMain") ? ["main", "androidMain"] : ["main"];
  const rank = (sourceSet) => (everyBuild.includes(sourceSet) ? everyBuild.indexOf(sourceSet) : everyBuild.length);
  return sourceSets
    .filter((sourceSet) => !isTestSourceSet(sourceSet) && tree.subdirectories(`${src}/${sourceSet}`).includes("res"))
    .sort((a, b) => rank(a) - rank(b))
    .map((sourceSet) => ({ sourceSet, res: `${src}/${sourceSet}/res`, everyBuild: everyBuild.includes(sourceSet) }));
}

/** The strings of the `values` or `values-cs` directory of every given resource directory; the first one wins. */
function mergedAndroidStrings(tree, directories, values) {
  const strings = new Map();
  for (const { res } of directories) {
    for (const [name, string] of androidStrings(tree, `${res}/${values}`)) if (!strings.has(name)) strings.set(name, string);
  }
  return strings;
}

/** Whether a String Catalog localization holds a translated, non-blank value, in every variation if it has variations. */
function translated(localization) {
  if (localization?.stringUnit) {
    const { state, value } = localization.stringUnit;
    return state === "translated" && typeof value === "string" && value.trim() !== "";
  }
  if (localization?.variations) {
    return Object.values(localization.variations).every((cases) => Object.values(cases).every(translated));
  }
  return false;
}

function checkCopy(ctx) {
  const rule = "COPY-PARITY";
  const found = [];
  const androidModules = new Set();
  const appleResourceDirectories = [];
  for (const entry of ctx.policy.copy) {
    const androidOnly = entry.androidOnly ?? [];
    const untranslatable = entry.androidUntranslatable ?? [];
    androidModules.add(entry.android);
    const copyDirectories = androidResourceDirectories(ctx.tree, entry.android).filter((directory) => directory.everyBuild);
    const primary = copyDirectories[0]?.res ?? `${moduleDirectory(entry.android)}/src/main/res`;
    const res = copyDirectories.length > 1 ? copyDirectories.map((directory) => directory.res).join(" and ") : primary;
    const values = mergedAndroidStrings(ctx.tree, copyDirectories, "values");
    const czech = mergedAndroidStrings(ctx.tree, copyDirectories, "values-cs");
    const expected = [...entry.keys, ...androidOnly].map((key) => key.replaceAll(".", "_"));
    for (const name of expected) {
      const english = values.get(name);
      if (!english) {
        found.push(violation(rule, `${primary}/values`, null, `${entry.android} lacks the string ${name}`));
        continue;
      }
      if (english.blank) found.push(violation(rule, english.file, english.line, `${name} has an empty English value`));
      const translation = czech.get(name);
      if (!translation) found.push(violation(rule, english.file, english.line, `${name} has no Czech translation in values-cs of ${res}`));
      else if (translation.blank) found.push(violation(rule, translation.file, translation.line, `${name} has an empty Czech translation`));
    }
    for (const name of untranslatable) {
      const english = values.get(name);
      if (!english) {
        found.push(violation(rule, `${primary}/values`, null, `${entry.android} lacks the untranslatable string ${name}`));
        continue;
      }
      if (english.translatable) found.push(violation(rule, english.file, english.line, `${name} is listed in androidUntranslatable but lacks translatable="false"`));
      if (english.blank) found.push(violation(rule, english.file, english.line, `${name} has an empty value`));
    }
    for (const [name, string] of values) {
      if (!expected.includes(name) && !untranslatable.includes(name)) {
        found.push(violation(rule, string.file, string.line, `${name} is not a copy key of ${entry.android} in ${POLICY_FILE}`));
      }
    }
    for (const [name, string] of czech) {
      if (!values.has(name)) found.push(violation(rule, string.file, string.line, `${name} has no English value in values of ${res}`));
    }

    const spec = ctx.appleTargets.get(entry.apple);
    if (!spec) {
      found.push(violation(rule, POLICY_FILE, null, `copy names the Apple target ${entry.apple}, which apple.targets does not list`));
      continue;
    }
    const resources = `apple/${spec.project}/Resources`;
    appleResourceDirectories.push(`${resources}/`);
    const catalogs = ctx.tree.files(resources, ".xcstrings");
    if (catalogs.length === 0) found.push(violation(rule, resources, null, `${entry.apple} has no String Catalog`));
    const appleKeys = new Map();
    for (const catalog of catalogs) {
      let parsed;
      try {
        parsed = JSON.parse(ctx.tree.text(catalog));
      } catch (error) {
        found.push(violation(rule, catalog, null, `is not valid JSON: ${error.message}`));
        continue;
      }
      // English is the source language: an English value is what a locale without its own translation shows.
      if (parsed?.sourceLanguage !== "en") {
        found.push(violation(rule, catalog, null, `has the sourceLanguage ${JSON.stringify(parsed?.sourceLanguage ?? null)}; copy is written in English, so it must be "en"`));
      }
      for (const [key, value] of Object.entries(parsed?.strings ?? {})) appleKeys.set(key, { catalog, value });
    }
    for (const key of entry.keys) {
      const string = appleKeys.get(key);
      if (!string) {
        found.push(violation(rule, catalogs[0] ?? resources, null, `${entry.apple} lacks the key ${key}`));
        continue;
      }
      if (!translated(string.value?.localizations?.en)) found.push(violation(rule, string.catalog, null, `${key} has no translated, non-empty English (en) value`));
      if (!translated(string.value?.localizations?.cs)) found.push(violation(rule, string.catalog, null, `${key} has no translated, non-empty Czech (cs) value`));
    }
    for (const [key, string] of appleKeys) {
      if (!entry.keys.includes(key)) {
        const why = androidOnly.includes(key) ? "it is Android-only (androidOnly)" : `it is not a copy key of ${entry.apple} in ${POLICY_FILE}`;
        found.push(violation(rule, string.catalog, null, `has the key ${key}, but ${why}`));
      }
    }
  }
  for (const module of ctx.modules) {
    let first = null;
    for (const { sourceSet, res, everyBuild } of androidResourceDirectories(ctx.tree, module)) {
      for (const values of ctx.tree.subdirectories(res).filter((name) => /^values(?:-|$)/.test(name))) {
        for (const [name, string] of androidStrings(ctx.tree, `${res}/${values}`)) {
          first ??= string;
          if (!everyBuild) {
            found.push(violation(rule, string.file, string.line, `${name} is in src/${sourceSet}/res, which not every build of ${module} compiles; copy lives in src/main/res (src/androidMain/res in a Kotlin Multiplatform module)`));
          }
        }
      }
    }
    if (first && !androidModules.has(module)) {
      found.push(violation(rule, first.file, first.line, `${module} has string resources but no entry in copy of ${POLICY_FILE}`));
    }
  }
  for (const catalog of ctx.tree.files("apple", ".xcstrings")) {
    if (!appleResourceDirectories.some((dir) => catalog.startsWith(dir))) {
      found.push(violation(rule, catalog, null, `belongs to no Apple target in copy of ${POLICY_FILE}`));
    }
  }
  return found;
}

function checkWrapper(ctx) {
  const rule = "WRAPPER";
  const jar = path.join(ctx.root, WRAPPER_JAR);
  const recorded = ctx.tree.text(WRAPPER_CHECKSUM)?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!existsSync(jar)) return [violation(rule, WRAPPER_JAR, null, "does not exist")];
  if (!recorded) return [violation(rule, WRAPPER_CHECKSUM, null, "does not exist or is empty")];
  const actual = createHash("sha256").update(readFileSync(jar)).digest("hex");
  return actual === recorded ? [] : [violation(rule, WRAPPER_JAR, null, `has SHA-256 ${actual}, but ${WRAPPER_CHECKSUM} records ${recorded}`)];
}

const CHECKS = {
  "ARCH-GRADLE": checkGradle,
  "ARCH-APPLE": checkApple,
  "KMP-COMMON": checkKmpCommon,
  "KMP-FRAMEWORK": checkKmpFramework,
  "VM-BRIDGE": checkViewModelBridges,
  "NAV-OWNERSHIP": checkNavigation,
  "APPLE-IDENTITY": checkAppleIdentity,
  "ORG-SCREEN": checkScreenFolders,
  "COPY-PARITY": checkCopy,
  WRAPPER: checkWrapper,
};

/** Every violation of every rule in the mobile directory `root`; empty when the tree follows all rules. */
export function checkArchitecture(root) {
  const ctx = context(root);
  return RULES.flatMap(({ id }) => CHECKS[id](ctx));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error(`architecture: expected at most one directory argument, got ${args.length}`);
    process.exit(1);
  }
  const root = path.resolve(args[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  let violations;
  try {
    violations = checkArchitecture(root);
  } catch (error) {
    console.error(`architecture: ${error.message}`);
    process.exit(1);
  }
  const shown = (file) => path.posix.join(path.basename(root), file);
  const width = Math.max(...RULES.map((r) => r.id.length));
  let failedRules = 0;
  for (const { id, summary } of RULES) {
    const mine = violations.filter((v) => v.rule === id);
    console.log(`${mine.length ? "FAIL" : "ok  "} ${id.padEnd(width)}  ${summary}`);
    for (const v of mine) console.log(`       ${shown(v.file)}${v.line ? `:${v.line}` : ""}: ${v.message}`);
    if (mine.length) failedRules += 1;
  }
  if (failedRules) {
    console.log(`architecture: ${failedRules} of ${RULES.length} rules failed with ${violations.length} violation(s); fixes in mobile/docs/verify.md`);
    process.exit(1);
  }
  console.log(`architecture: all ${RULES.length} rules passed`);
}

/**
 * Whether Node runs this file as its entry script. Node resolves symbolic links in the entry module's URL but
 * leaves `process.argv[1]` as typed, so both sides are compared as real paths: run through a symlinked path
 * (`/tmp` on macOS, a symlinked checkout), a lexical comparison would never call main() and exit 0 unchecked.
 */
function isEntryScript() {
  const entry = process.argv[1];
  // No entry file (`node -e`, a REPL) or an argument that names no file (`node -e "…" <arg>`): this file is imported.
  if (!entry || !existsSync(entry)) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
}

if (isEntryScript()) main();
