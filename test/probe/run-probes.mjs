#!/usr/bin/env node
/*
 * run-probes.mjs — run the probes in test/probe/probes.mjs against a php-wasm
 * build in a real headless Chromium, and print what each one did.
 *
 * Two things it can point at:
 *
 *   --target published   the package the site consumes today, straight from
 *                        the CDN.  This is the "before" picture, and running
 *                        it is how the Fiber abort gets reproduced rather
 *                        than taken on trust.
 *
 *   --target local       a build produced by scripts/build-php.sh.  This is
 *                        the "after" picture.
 *
 * Each probe gets a fresh page and a fresh PHP instance.  That is not
 * tidiness: several runtimes in one page exhaust memory and the page dies in
 * a way that looks like a bug in the probe rather than in PHP.  It also means
 * a probe that aborts cannot poison the ones after it.
 *
 * Usage:
 *   node test/probe/run-probes.mjs --target published
 *   node test/probe/run-probes.mjs --target published --version 3.1.50
 *   node test/probe/run-probes.mjs --target local
 *   node test/probe/run-probes.mjs --target local --only fiber-start-suspend-resume
 *   node test/probe/run-probes.mjs --target published --headed --json out.json
 *
 * Exit status is 0 when every probe met its expectation, 1 otherwise.  A run
 * against the published build is therefore expected to exit 1 — that is the
 * bug being reproduced, and the output says so probe by probe.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { probes } from './probes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const options = {
	target: 'published',
	version: '3.1.50',
	phpVersion: '8.5.8',
	buildDir: join(projectRoot, 'upstream/packages/php-wasm/web-builds/8-5/asyncify'),
	only: null,
	headed: false,
	json: null,
	timeout: 60000,
};

for (let i = 0; i < argv.length; i++) {
	const flag = argv[i];
	if (flag === '--target') options.target = argv[++i];
	else if (flag === '--version') options.version = argv[++i];
	else if (flag === '--php-version') options.phpVersion = argv[++i];
	else if (flag === '--build-dir') options.buildDir = resolve(argv[++i]);
	else if (flag === '--only') options.only = argv[++i];
	else if (flag === '--headed') options.headed = true;
	else if (flag === '--json') options.json = argv[++i];
	else if (flag === '--timeout') options.timeout = Number(argv[++i]);
	else if (flag === '--help' || flag === '-h') {
		console.log(
			[
				'usage: run-probes.mjs [--target published|local] [options]',
				'  --version X.Y.Z     @php-wasm package version (published target)',
				'  --php-version X.Y.Z PHP version (default 8.5.8)',
				'  --build-dir DIR     where a local build lives',
				'  --only NAME         run a single probe',
				'  --headed            show the browser',
				'  --json FILE         also write the results as JSON',
				'  --timeout MS        per-probe timeout (default 60000)',
			].join('\n')
		);
		process.exit(0);
	} else {
		console.error(`unknown option: ${flag}`);
		process.exit(2);
	}
}

if (!['published', 'local'].includes(options.target)) {
	console.error(`--target must be "published" or "local"`);
	process.exit(2);
}

// ---------------------------------------------------------------------------
// A small static server.  Even the published target needs one: a dynamic
// import from a CDN needs a real origin, and about:blank has none.
// ---------------------------------------------------------------------------

const contentTypes = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.data': 'application/octet-stream',
};

async function startServer(rootDir) {
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		if (url.pathname === '/' || url.pathname === '/index.html') {
			response.writeHead(200, { 'content-type': contentTypes['.html'] });
			response.end('<!doctype html><meta charset="utf-8"><title>php-wasm probes</title>');
			return;
		}

		const filePath = join(rootDir ?? '', decodeURIComponent(url.pathname));
		if (!rootDir || !filePath.startsWith(rootDir) || !existsSync(filePath)
			|| !statSync(filePath).isFile()) {
			response.writeHead(404).end('not found');
			return;
		}

		let body = await readFile(filePath);

		/*
		 * The loader a fresh build produces opens with
		 *
		 *     import dependencyFilename from './8_5_8/php_8_5.wasm';
		 *
		 * which is a bundler instruction, not JavaScript a browser can run —
		 * no browser imports a .wasm file as an ES module. Upstream's npm
		 * package is published through a bundler that rewrites that line, so
		 * the published build works in a browser and a locally built one does
		 * not. Rewriting it to the URL form a bundler would emit is what lets
		 * the same probes run against both.
		 */
		if (extname(filePath) === '.js') {
			body = Buffer.from(
				body
					.toString('utf8')
					.replace(
						/^import\s+(\w+)\s+from\s+'([^']+\.wasm)';/m,
						"const $1 = new URL('$2', import.meta.url).href;"
					)
			);
		}

		response.writeHead(200, {
			'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
			// Emscripten's streaming instantiation wants a real length.
			'content-length': body.length,
		});
		response.end(body);
	});

	await new Promise((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address();
	return { server, origin: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------
// Where the runtime comes from, for each target
// ---------------------------------------------------------------------------

function resolveSources(origin) {
	if (options.target === 'published') {
		const v = options.version;
		return {
			describe: `@php-wasm/web-8-5@${v} (asyncify, PHP ${options.phpVersion}) from the CDN`,
			loaderUrl: `https://esm.sh/@php-wasm/web-8-5@${v}/es2022/asyncify/php_8_5.mjs`,
			universalUrl: `https://esm.sh/@php-wasm/universal@${v}`,
			wasmUrl:
				`https://cdn.jsdelivr.net/npm/@php-wasm/web-8-5@${v}` +
				`/asyncify/${options.phpVersion.replaceAll('.', '_')}/php_8_5.wasm`,
		};
	}

	const loader = join(options.buildDir, 'php_8_5.js');
	const wasm = join(
		options.buildDir,
		options.phpVersion.replaceAll('.', '_'),
		'php_8_5.wasm'
	);
	for (const [what, path] of [['loader', loader], ['wasm binary', wasm]]) {
		if (!existsSync(path)) {
			console.error(
				`the local build has no ${what} at ${path}\n` +
					`run scripts/build-php.sh first, or pass --build-dir`
			);
			process.exit(2);
		}
	}
	return {
		describe: `local build in ${options.buildDir}`,
		loaderUrl: `${origin}/php_8_5.js`,
		universalUrl: `https://esm.sh/@php-wasm/universal@${options.version}`,
		wasmUrl: `${origin}/${options.phpVersion.replaceAll('.', '_')}/php_8_5.wasm`,
	};
}

// ---------------------------------------------------------------------------
// Running one probe
// ---------------------------------------------------------------------------

/*
 * Runs inside the browser page.  Returns a plain object either way — a PHP
 * abort has to come back as data, because throwing here would be
 * indistinguishable from the harness itself breaking.
 */
async function probeInPage({ sources, runs }) {
	const messages = [];
	try {
		const [loaderModule, universalModule] = await Promise.all([
			import(/* @vite-ignore */ sources.loaderUrl),
			import(/* @vite-ignore */ sources.universalUrl),
		]);

		const runtimeId = await universalModule.loadPHPRuntime(loaderModule, {
			instantiateWasm: (imports, receive) =>
				WebAssembly.instantiateStreaming(fetch(sources.wasmUrl), imports).then(
					(made) => {
						receive(made.instance, made.module);
						return made.instance;
					}
				),
		});

		const php = new universalModule.PHP(runtimeId);

		const results = [];
		for (const code of runs) {
			try {
				const result = await php.run({ code });
				results.push({
					ok: true,
					text: result.text,
					errors: result.errors ?? '',
					exitCode: result.exitCode,
				});
			} catch (error) {
				results.push({
					ok: false,
					text: '',
					error: String(error?.message ?? error),
				});
			}
		}

		return { ok: true, runs: results, messages };
	} catch (error) {
		return {
			ok: false,
			runs: [],
			error: String(error?.message ?? error),
			messages,
		};
	}
}

async function runProbe(browser, sources, probe) {
	const runs = probe.runs ?? [probe.code];
	const context = await browser.newContext();
	const page = await context.newPage();

	const consoleLines = [];
	page.on('console', (message) => consoleLines.push(message.text()));
	page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));

	let outcome;
	try {
		await page.goto(`${sources.origin}/`);
		outcome = await Promise.race([
			page.evaluate(probeInPage, { sources: { ...sources }, runs }).then(
				(value) => value,
				(error) => ({
					ok: false,
					runs: [],
					error: String(error?.message ?? error),
				})
			),
			new Promise((done) =>
				setTimeout(
					() => done({ ok: false, runs: [], error: 'timed out' }),
					options.timeout
				)
			),
		]);
	} catch (error) {
		outcome = { ok: false, runs: [], error: String(error?.message ?? error) };
	} finally {
		await context.close().catch(() => {});
	}

	const first = outcome.runs?.[0] ?? {};
	const result = {
		name: probe.name,
		what: probe.what,
		known: probe.known,
		text: (first.text ?? '').trim(),
		errors: (first.errors ?? '').trim(),
		failure: outcome.error ?? first.error ?? null,
		runs: outcome.runs ?? [],
		console: consoleLines,
	};

	result.met = (() => {
		try {
			return Boolean(probe.expect(result));
		} catch {
			return false;
		}
	})();

	if (probe.report) {
		try {
			result.detail = probe.report(result);
		} catch {
			/* a probe that could not report is already a failure */
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function describeFailure(result) {
	if (result.failure) {
		// The abort text is the interesting part; the stack is noise here.
		return result.failure.split('\n')[0];
	}
	if (result.text) {
		return `ran, but the output was not what a fixed build gives: ${JSON.stringify(
			result.text.slice(0, 120)
		)}`;
	}
	return 'no output and no error';
}

function report(results, sources) {
	console.log(`\nprobes against ${sources.describe}\n`);

	const width = Math.max(...results.map((r) => r.name.length));
	for (const result of results) {
		const mark = result.met ? 'ok  ' : 'FAIL';
		console.log(`${mark} ${result.name.padEnd(width)}  ${result.what}`);
		if (!result.met) {
			console.log(`     ${describeFailure(result)}`);
			if (result.known) {
				console.log(`     known behavior of the shipped build: ${result.known}`);
			}
		}
		if (result.detail) {
			console.log(`     ${JSON.stringify(result.detail)}`);
		}
	}

	const met = results.filter((r) => r.met).length;
	console.log(`\n${met} of ${results.length} probes met their expectation`);
	return met === results.length;
}

// ---------------------------------------------------------------------------

const chosen = options.only
	? probes.filter((p) => p.name === options.only)
	: probes;

if (chosen.length === 0) {
	console.error(`no probe named ${options.only}`);
	process.exit(2);
}

const { server, origin } = await startServer(
	options.target === 'local' ? options.buildDir : null
);
const sources = { ...resolveSources(origin), origin };

const browser = await chromium.launch({ headless: !options.headed });
const results = [];
try {
	for (const probe of chosen) {
		process.stderr.write(`  running ${probe.name}...\r`);
		results.push(await runProbe(browser, sources, probe));
	}
	process.stderr.write('                                        \r');
} finally {
	await browser.close();
	server.close();
}

const everythingMet = report(results, sources);

if (options.json) {
	const { writeFile } = await import('node:fs/promises');
	await writeFile(
		options.json,
		JSON.stringify({ target: options.target, sources, results }, null, 2)
	);
	console.log(`results written to ${options.json}`);
}

process.exit(everythingMet ? 0 : 1);
