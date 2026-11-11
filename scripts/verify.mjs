#!/usr/bin/env node
/**
 * Release self-check for @tuweizhi/dsh-session-delete.
 *
 * Runs before `npm publish` (`prepublishOnly`) and in CI (`npm run check`). It answers one
 * question: would DSH be able to install *this* tarball and mount both halves?
 *
 * Checks
 *   - package.json shape: the fields DSH reads (dsh.bundle.patch, dsh.client, engines, main,
 *     exports, files, repository, publishConfig) plus a valid semver version;
 *   - every shipped path exists — `files` is the packaging contract, so a typo there means a
 *     silently broken tarball;
 *   - cordis.patch.yml inserts exactly one entry whose `name` is this package's name, and no
 *     entry line carries a trailing comment (the marketplace precheck parses those lines);
 *   - the icon resolves inside the package and stays within DSH's inlining budget;
 *   - locale/en.json + locale/zh.json parse and carry a title;
 *   - `node --check` passes for both halves;
 *   - the client bundle registers under the package name (that id is how the roster finds it)
 *     and never reloads the page;
 *   - no machine-specific absolute path leaked into shipped text.
 *
 * Exit code 1 on any failure, with every failure listed at the end.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const failures = [];
const notes = [];

function ok(label, detail) {
	console.log(`  ok   ${label}${detail === void 0 ? "" : ` — ${detail}`}`);
}

function fail(label, detail) {
	failures.push(`${label}: ${detail}`);
	console.log(`  FAIL ${label} — ${detail}`);
}

async function readText(relative) {
	return readFile(path.join(root, relative), "utf8");
}

async function exists(relative) {
	try {
		await stat(path.join(root, relative));
		return true;
	} catch {
		return false;
	}
}

/** Expand the one glob shape `files` actually uses: `dir/<star>.ext`. */
async function expand(entry) {
	if (!entry.includes("*")) {
		return (await exists(entry)) ? [entry] : [];
	}
	const dir = path.posix.dirname(entry);
	const pattern = path.posix.basename(entry);
	const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
	let names;
	try {
		names = await readdir(path.join(root, dir));
	} catch {
		return [];
	}
	return names.filter((name) => regex.test(name)).map((name) => path.posix.join(dir, name));
}

console.log("dsh-session-delete — release self-check\n");

// ---------------------------------------------------------------- package.json ----
let manifest;
try {
	manifest = JSON.parse(await readText("package.json"));
} catch (error) {
	fail("package.json", `not readable JSON (${error.message})`);
	console.log(`\n${failures.length} failure(s)`);
	process.exit(1);
}

const required = [
	"name",
	"version",
	"description",
	"license",
	"author",
	"type",
	"main",
	"exports",
	"files",
	"engines",
	"repository",
	"publishConfig",
	"dsh"
];
const missing = required.filter((key) => manifest[key] === void 0);
if (missing.length > 0) fail("manifest fields", `missing ${missing.join(", ")}`);
else ok("manifest fields", required.join(", "));

if (manifest.type !== "module") fail("manifest type", `expected "module", found ${JSON.stringify(manifest.type)}`);
else ok("manifest type", "module (ESM host half)");

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.version))) {
	fail("version", `${JSON.stringify(manifest.version)} is not a publishable semver`);
} else ok("version", manifest.version);

if (manifest.publishConfig?.access !== "public") fail("publishConfig.access", "scoped packages must publish with access=public");
else ok("publishConfig.access", "public");

if (typeof manifest.repository?.url !== "string" || !manifest.repository.url.includes("github.com")) {
	fail("repository.url", "expected a github.com URL");
} else ok("repository.url", manifest.repository.url);

if (manifest.engines?.node === void 0 || manifest.engines?.dsh === void 0) {
	fail("engines", "must declare both node and dsh ranges");
} else ok("engines", `node ${manifest.engines.node}, dsh ${manifest.engines.dsh}`);

if (manifest.dsh?.bundle?.patch !== "./cordis.patch.yml") {
	fail("dsh.bundle.patch", `expected "./cordis.patch.yml", found ${JSON.stringify(manifest.dsh?.bundle?.patch)}`);
} else ok("dsh.bundle.patch", manifest.dsh.bundle.patch);

const clientSpec = manifest.dsh?.client;
if (clientSpec === void 0) fail("dsh.client", "missing — DSH would not load the browser half");
else if (clientSpec.platform !== "web") fail("dsh.client.platform", `expected "web", found ${JSON.stringify(clientSpec.platform)}`);
else if (!Array.isArray(clientSpec.inject) || clientSpec.inject.length === 0) fail("dsh.client.inject", "must list the client services the half injects");
else ok("dsh.client", `platform web, inject [${clientSpec.inject.join(", ")}]`);

if (manifest.exports?.["."] !== `./${manifest.main}`) {
	fail("exports['.']", `expected "./${manifest.main}", found ${JSON.stringify(manifest.exports?.["."])}`);
} else ok("exports['.']", manifest.exports["."]);

// ------------------------------------------------------------- shipped files ----
const declared = Array.isArray(manifest.files) ? manifest.files : [];
const shipped = [];
for (const entry of declared) shipped.push(...(await expand(entry)));
const absent = [];
for (const entry of declared) if ((await expand(entry)).length === 0) absent.push(entry);
if (absent.length > 0) fail("files[]", `declared but absent: ${absent.join(", ")}`);
else ok("files[]", `${declared.length} entries, ${shipped.length} paths present`);

for (const key of ["LICENSE", "README.md", "README.zh.md", "CHANGELOG.md"]) {
	if (!shipped.includes(key)) fail("files[]", `${key} is not packaged (users and npm both expect it)`);
}

// -------------------------------------------------------- cordis.patch.yml ----
const patchPath = manifest.dsh?.bundle?.patch?.replace(/^\.\//, "");
if (typeof patchPath !== "string" || !(await exists(patchPath))) {
	fail("bundle patch", `${patchPath ?? "(unset)"} does not exist`);
} else {
	const patch = await readText(patchPath);
	const nameLines = patch.split(/\r?\n/).filter((line) => /^\s+name:/.test(line));
	const idLines = patch.split(/\r?\n/).filter((line) => /^\s+-?\s*id:/.test(line));
	if (idLines.length !== 1) fail("bundle patch", `expected exactly one id line, found ${idLines.length}`);
	if (nameLines.length !== 1) fail("bundle patch", `expected exactly one name line, found ${nameLines.length}`);
	const parsedName = nameLines[0]?.replace(/^\s+name:\s*/, "").replace(/^['"]|['"]$/g, "").trim();
	if (parsedName !== manifest.name) {
		fail("bundle patch", `insert name ${JSON.stringify(parsedName)} must equal package name ${JSON.stringify(manifest.name)}`);
	} else ok("bundle patch", `inserts ${parsedName}`);
	const commented = [...idLines, ...nameLines].filter((line) => line.includes("#"));
	if (commented.length > 0) {
		fail("bundle patch", `entry lines must not carry a trailing comment (marketplace precheck): ${commented[0].trim()}`);
	} else ok("bundle patch entry style", "no trailing comments");
}

// -------------------------------------------------------------------- icon ----
const icon = manifest.icon;
if (typeof icon !== "string") {
	fail("icon", "manifest declares no icon");
} else if (!(await exists(icon))) {
	fail("icon", `${icon} does not exist`);
} else if (path.isAbsolute(icon) || icon.split(/[\\/]/).includes("..")) {
	fail("icon", `${icon} must stay inside the package`);
} else {
	const bytes = await readFile(path.join(root, icon));
	const budget = 256 * 1024;
	if (bytes.length > budget) fail("icon", `${bytes.length} bytes exceeds ${budget}`);
	else if (!bytes.toString("utf8", 0, 4).trimStart().startsWith("<svg") && !bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
		fail("icon", "must be SVG or PNG");
	} else ok("icon", `${icon}, ${bytes.length} bytes`);
}

// ------------------------------------------------------------------ locale ----
for (const locale of ["en", "zh"]) {
	const file = `locale/${locale}.json`;
	if (!(await exists(file))) {
		fail("locale", `${file} is missing`);
		continue;
	}
	try {
		const parsed = JSON.parse(await readText(file));
		const title = parsed?.meta?.title;
		const description = parsed?.meta?.description;
		if (typeof title !== "string" || title.trim() === "") fail("locale", `${file} has no meta.title`);
		else if (typeof description !== "string" || description.trim() === "") fail("locale", `${file} has no meta.description`);
		else ok("locale", `${file} → ${title}`);
	} catch (error) {
		fail("locale", `${file} is not valid JSON (${error.message})`);
	}
}

// ------------------------------------------------------------- syntax check ----
for (const file of ["lib/index.js", "lib/client.js"]) {
	if (!(await exists(file))) {
		fail("syntax", `${file} is missing`);
		continue;
	}
	const check = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
	if (check.status !== 0) fail("syntax", `${file}: ${(check.stderr || check.stdout).trim().split("\n").slice(0, 3).join(" ")}`);
	else ok("syntax", file);
}

// ----------------------------------------------------------- client bundle ----
if (await exists("lib/client.js")) {
	const client = await readText("lib/client.js");
	const idLine = /__ModuleLoader__\.load\(\s*\{[\s\S]{0,200}?id:\s*(["'])(.*?)\1/.exec(client);
	if (idLine === null) fail("client bundle", "no window.__ModuleLoader__.load({ id }) registration found");
	else if (idLine[2] !== manifest.name) {
		fail("client bundle", `registers as ${JSON.stringify(idLine[2])}, must equal the package name ${JSON.stringify(manifest.name)}`);
	} else ok("client bundle id", idLine[2]);

	for (const [needle, why] of [
		["location.reload", "the delete flow must not reload the page"],
		["clearMain", "the deleted session must be cleared from the main view"]
	]) {
		const present = client.includes(needle);
		if (needle === "location.reload" ? present : !present) fail("client bundle", `${why} (${needle})`);
		else ok("client bundle", `${needle} ${present ? "present" : "absent"} as required`);
	}
}

// ---------------------------------------------------------- absolute paths ----
const textFiles = [...shipped.filter((file) => /\.(js|json|md|yml|svg)$/i.test(file)), patchPath].filter(
	(file) => typeof file === "string"
);
const offenders = [];
for (const file of new Set(textFiles)) {
	let text;
	try {
		text = await readText(file);
	} catch {
		continue;
	}
	// C:\..., /Users/..., /home/... — a leaked developer path means the tarball is not portable.
	const match = /[A-Za-z]:\\Users\\|\/Users\/[^/\s]+\/|\/home\/[^/\s]+\//.exec(text);
	if (match !== null) offenders.push(`${file} (${match[0]})`);
}
if (offenders.length > 0) fail("absolute paths", `machine paths leaked: ${offenders.join(", ")}`);
else ok("absolute paths", `${new Set(textFiles).size} shipped text files clean`);

// ------------------------------------------------------------------ report ----
if (notes.length > 0) {
	console.log("\nnotes:");
	for (const note of notes) console.log(`  - ${note}`);
}
if (failures.length > 0) {
	console.log(`\n${failures.length} failure(s):`);
	for (const failure of failures) console.log(`  ✗ ${failure}`);
	process.exit(1);
}
console.log("\nall checks passed");
