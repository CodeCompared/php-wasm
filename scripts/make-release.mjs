#!/usr/bin/env node
/*
 * make-release.mjs — stage a release of the built PHP runtime.
 *
 * Collects what a consumer needs, records exactly which sources produced it,
 * and writes a VENDORED.json alongside so that "which build is this?" has an
 * answer and a swapped file shows up as a diff rather than as a site whose
 * output quietly changed.
 *
 * What it stages
 *   php_8_5.js          the loader, with one line rewritten (see below)
 *   8_5_8/php_8_5.wasm  the binary
 *   VENDORED.json       provenance and checksums
 *
 * The rewritten line
 * ------------------
 * A fresh build's loader opens with
 *
 *     import dependencyFilename from './8_5_8/php_8_5.wasm';
 *
 * which is an instruction to a bundler, not JavaScript a browser can run — no
 * browser imports a .wasm file as an ES module. Upstream publishes to npm
 * through Vite, which rewrites that line; a locally built loader has never
 * been through it. Rather than reproduce their whole bundling step, this
 * rewrites that one import into the URL form a bundler emits, which is what
 * makes the file loadable straight from a URL. The rewrite is recorded in
 * VENDORED.json rather than done silently.
 *
 * Provenance
 * ----------
 * Two repositories produce this artifact and both are recorded: this one, and
 * the WordPress Playground checkout in upstream/ that carries the patches.
 * Each gets a commit and a clean/dirty flag. `dirty` is the confession field:
 * it means the build came from an uncommitted working tree, so nobody else can
 * reproduce it.
 *
 * Usage:
 *   node scripts/make-release.mjs --tag v0.1.0
 *   node scripts/make-release.mjs --tag v0.1.0 --out /tmp/release
 *
 * It only stages files. Publishing is a separate, deliberate step — see the
 * command it prints when it finishes.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const argv = process.argv.slice(2);
let tag = null;
let outDir = join(projectRoot, 'release');
let phpVersion = '8.5.8';
let buildDir = join(projectRoot, 'upstream/packages/php-wasm/web-builds/8-5/asyncify');

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--tag') tag = argv[++i];
	else if (argv[i] === '--out') outDir = resolve(argv[++i]);
	else if (argv[i] === '--php-version') phpVersion = argv[++i];
	else if (argv[i] === '--build-dir') buildDir = resolve(argv[++i]);
	else if (argv[i] === '--help' || argv[i] === '-h') {
		console.log('usage: make-release.mjs --tag vX.Y.Z [--out DIR] [--php-version X.Y.Z]');
		process.exit(0);
	} else {
		console.error(`unknown option: ${argv[i]}`);
		process.exit(2);
	}
}

if (!tag) {
	console.error('--tag is required, e.g. --tag v0.1.0');
	process.exit(2);
}

const versionDir = phpVersion.replaceAll('.', '_');

function git(repo, ...args) {
	return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

/*
 * `git status --porcelain` writes two status characters and a space before
 * each path, and the first of those characters is a space for an unstaged
 * change -- so trimming the output eats it and every path in the first line
 * comes back one character short. Read this one untrimmed.
 */
function gitStatusPaths(repo) {
	return execFileSync('git', ['-C', repo, 'status', '--porcelain'], {
		encoding: 'utf8',
	})
		.split('\n')
		.filter(Boolean)
		.map((line) => line.slice(3));
}

function describeRepo(repo, label) {
	if (!existsSync(join(repo, '.git'))) {
		throw new Error(`${label}: ${repo} is not a git repository`);
	}
	const changed = gitStatusPaths(repo);
	return {
		commit: git(repo, 'rev-parse', 'HEAD'),
		branch: git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'),
		// Anything uncommitted means this build cannot be reproduced from the
		// recorded commit. Say so rather than record a commit that is a lie.
		tree: changed.length ? 'dirty' : 'clean',
	};
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------

const upstreamRepo = join(projectRoot, 'upstream');
const loaderPath = join(buildDir, 'php_8_5.js');
const wasmPath = join(buildDir, versionDir, 'php_8_5.wasm');

for (const [what, path] of [['loader', loaderPath], ['wasm binary', wasmPath]]) {
	if (!existsSync(path)) {
		console.error(`no ${what} at ${path}\nrun scripts/build-php.sh first`);
		process.exit(2);
	}
}

const phpWasm = describeRepo(projectRoot, 'php-wasm');
const playground = describeRepo(upstreamRepo, 'upstream');

// The upstream checkout always has modified build artifacts in its working
// tree, because scripts/build-php.sh writes the build into it. That is not the
// kind of dirty that makes a build unreproducible, so report what is dirty.
const playgroundDirtyOutsideBuildOutput = gitStatusPaths(upstreamRepo).filter(
	(path) => !path.startsWith('packages/php-wasm/web-builds/')
);

mkdirSync(join(outDir, versionDir), { recursive: true });

// --- the loader, with the bundler-only import rewritten ---------------------

const loaderSource = readFileSync(loaderPath, 'utf8');
const importPattern = /^import\s+(\w+)\s+from\s+'([^']+\.wasm)';/m;
const importMatch = loaderSource.match(importPattern);
if (!importMatch) {
	console.error(
		`the loader at ${loaderPath} has no ".wasm" import to rewrite.\n` +
			`Either the build changed shape or it has already been processed; ` +
			`check before publishing it.`
	);
	process.exit(2);
}
const loaderRewritten = loaderSource.replace(
	importPattern,
	"const $1 = new URL('$2', import.meta.url).href;"
);
const loaderBytes = Buffer.from(loaderRewritten, 'utf8');
writeFileSync(join(outDir, 'php_8_5.js'), loaderBytes);

// --- the binary, copied verbatim -------------------------------------------

const wasmBytes = readFileSync(wasmPath);
writeFileSync(join(outDir, versionDir, 'php_8_5.wasm'), wasmBytes);

// --- the record -------------------------------------------------------------

const vendored = {
	project: 'CodeCompared/php-wasm',
	tag,
	built: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
	php: {
		version: phpVersion,
		platform: 'web',
		variant: 'asyncify',
	},
	basedOn: {
		package: '@php-wasm/web-8-5',
		version: JSON.parse(readFileSync(join(upstreamRepo, 'lerna.json'), 'utf8'))
			.version,
		note:
			'Pairs with @php-wasm/universal at the same version, which is ' +
			'unmodified and still comes from npm.',
	},
	source: {
		phpWasm: phpWasm,
		playground: {
			...playground,
			upstreamBase: git(upstreamRepo, 'rev-parse', 'HEAD~3'),
			dirtyOutsideBuildOutput: playgroundDirtyOutsideBuildOutput,
		},
	},
	loaderRewrite: {
		from: importMatch[0],
		to: `const ${importMatch[1]} = new URL('${importMatch[2]}', import.meta.url).href;`,
		why:
			'The built loader imports the .wasm file the way a bundler expects. ' +
			'No browser can resolve that, so it is rewritten to the URL form a ' +
			'bundler would emit.',
	},
	files: [
		{
			path: 'php_8_5.js',
			bytes: loaderBytes.length,
			sha256: sha256(loaderBytes),
		},
		{
			path: `${versionDir}/php_8_5.wasm`,
			bytes: wasmBytes.length,
			sha256: sha256(wasmBytes),
		},
	],
};

writeFileSync(
	join(outDir, 'VENDORED.json'),
	JSON.stringify(vendored, null, 2) + '\n'
);

// ---------------------------------------------------------------------------

console.log(`staged ${tag} into ${outDir}\n`);
for (const file of vendored.files) {
	console.log(
		`  ${file.path.padEnd(24)} ${String(file.bytes).padStart(10)} bytes  ` +
			`${file.sha256.slice(0, 16)}…`
	);
}
console.log(`  ${'VENDORED.json'.padEnd(24)} ${String(statSync(join(outDir, 'VENDORED.json')).size).padStart(10)} bytes`);

console.log(`\nphp-wasm    ${phpWasm.commit.slice(0, 8)} (${phpWasm.tree})`);
console.log(`playground  ${playground.commit.slice(0, 8)} (${playground.tree})`);

if (phpWasm.tree === 'dirty') {
	console.log(
		'\n🚨 This repository has uncommitted changes, so this build cannot be\n' +
			'   reproduced from the commit recorded in VENDORED.json. Commit first.'
	);
}
if (playgroundDirtyOutsideBuildOutput.length) {
	console.log(
		'\n🚨 The upstream checkout has uncommitted changes outside the build\n' +
			'   output, so the patches that produced this are not all recorded:\n' +
			playgroundDirtyOutsideBuildOutput.map((p) => `     ${p}`).join('\n')
	);
}

console.log(`\nTo publish:
  gh release create ${tag} \\
      --repo CodeCompared/php-wasm \\
      --title ${tag} \\
      --notes-file docs/release-notes.md \\
      ${outDir}/php_8_5.js \\
      ${outDir}/${versionDir}/php_8_5.wasm \\
      ${outDir}/VENDORED.json`);
