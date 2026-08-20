#!/usr/bin/env node
/*
 * trace-trap.mjs — run one snippet of PHP against a local build and print the
 * full WebAssembly stack of whatever it trapped on.
 *
 * Why this exists
 * ---------------
 * php-wasm links with `-s ASYNCIFY_ONLY=[...]`, a hand-maintained list of the
 * functions Asyncify is allowed to pause.  When a function that is *not* on
 * the list ends up on the stack while something below it pauses, the program
 * traps on `unreachable` with no message.  The Dockerfile says as much, and
 * says the cure: read the stack and add every name on it to the list.
 *
 * Reading the stack is the hard part, because a shipping build strips the
 * WebAssembly name section and the trace comes back as bare function indices.
 * Build with WITH_FUNCTION_NAMES=yes first and the same trace names names.
 *
 * Usage:
 *   WITH_FUNCTION_NAMES=yes scripts/build-php.sh
 *   node scripts/trace-trap.mjs "<?php @fsockopen('example.com', 80);"
 *   node scripts/trace-trap.mjs --file snippet.php
 *   node scripts/trace-trap.mjs --names-only "<?php ..."   # just the names
 *
 * --names-only prints one function name per line, which is the form that
 * goes into the only-list.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const argv = process.argv.slice(2);
let code = null;
let namesOnly = false;
let buildDir = join(projectRoot, 'upstream/packages/php-wasm/web-builds/8-5/asyncify');
let phpVersion = '8.5.8';

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--names-only') namesOnly = true;
	else if (argv[i] === '--file') code = await readFile(argv[++i], 'utf8');
	else if (argv[i] === '--build-dir') buildDir = resolve(argv[++i]);
	else if (argv[i] === '--php-version') phpVersion = argv[++i];
	else code = argv[i];
}

if (!code) {
	console.error('usage: trace-trap.mjs [--names-only] "<?php ..." | --file FILE');
	process.exit(2);
}

const contentTypes = {
	'.js': 'text/javascript; charset=utf-8',
	'.wasm': 'application/wasm',
};

const server = createServer(async (request, response) => {
	const url = new URL(request.url, 'http://127.0.0.1');
	if (url.pathname === '/') {
		response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		response.end('<!doctype html><meta charset="utf-8"><title>trap trace</title>');
		return;
	}
	const filePath = join(buildDir, decodeURIComponent(url.pathname));
	if (!filePath.startsWith(buildDir) || !existsSync(filePath)
		|| !statSync(filePath).isFile()) {
		response.writeHead(404).end('not found');
		return;
	}
	let body = await readFile(filePath);
	// See run-probes.mjs: a locally built loader opens with a bundler-only
	// import of the .wasm file, which no browser can resolve.
	if (extname(filePath) === '.js') {
		body = Buffer.from(
			body.toString('utf8').replace(
				/^import\s+(\w+)\s+from\s+'([^']+\.wasm)';/m,
				"const $1 = new URL('$2', import.meta.url).href;"
			)
		);
	}
	response.writeHead(200, {
		'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
		'content-length': body.length,
	});
	response.end(body);
});

await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleLines = [];
page.on('console', (message) => consoleLines.push(message.text()));

await page.goto(`${origin}/`);

const outcome = await page.evaluate(
	async ({ origin, code, phpVersion }) => {
		const [loader, universal] = await Promise.all([
			import(/* @vite-ignore */ `${origin}/php_8_5.js`),
			import(/* @vite-ignore */ 'https://esm.sh/@php-wasm/universal@3.1.50'),
		]);
		const wasmUrl = `${origin}/${phpVersion.replaceAll('.', '_')}/php_8_5.wasm`;
		const runtimeId = await universal.loadPHPRuntime(loader, {
			instantiateWasm: (imports, receive) =>
				WebAssembly.instantiateStreaming(fetch(wasmUrl), imports).then((made) => {
					receive(made.instance, made.module);
					return made.instance;
				}),
		});
		const php = new universal.PHP(runtimeId);
		try {
			const result = await php.run({ code });
			return { trapped: false, text: result.text, errors: result.errors };
		} catch (error) {
			return {
				trapped: true,
				message: String(error?.message ?? error),
				stack: String(error?.stack ?? ''),
			};
		}
	},
	{ origin, code, phpVersion }
);

await browser.close();
server.close();

if (!outcome.trapped) {
	if (!namesOnly) {
		console.log('did not trap.  output:');
		console.log(outcome.text);
		if (outcome.errors?.trim()) console.log('stderr:', outcome.errors);
	}
	process.exit(0);
}

// Frames look like:
//   at NAME (http://127.0.0.1:1234/8_5_8/php_8_5.wasm:wasm-function[9185]:0x6b0f08)
// and, when a name is missing, like:
//   at http://.../php_8_5.wasm:wasm-function[9185]:0x6b0f08
const named = [];
const unnamed = [];
for (const line of outcome.stack.split('\n')) {
	const withName = line.match(/at\s+(\S+)\s+\(.*wasm-function\[(\d+)\]/);
	if (withName) {
		// V8 prefixes the module name, e.g. "php.wasm.php_fsockopen_stream".
		// The only-list wants the bare symbol.
		named.push({
			name: withName[1].replace(/^.*\.wasm\./, ''),
			index: Number(withName[2]),
		});
		continue;
	}
	const withoutName = line.match(/wasm-function\[(\d+)\]/);
	if (withoutName) unnamed.push(Number(withoutName[1]));
}

if (namesOnly) {
	for (const frame of named) console.log(frame.name);
	process.exit(0);
}

console.log(`trapped: ${outcome.message}\n`);
console.log('WebAssembly frames, innermost first:');
for (const frame of named) {
	console.log(`  ${String(frame.index).padStart(6)}  ${frame.name}`);
}
if (unnamed.length) {
	console.log(
		`\n${unnamed.length} frame(s) came back without a name: ${unnamed.join(', ')}` +
			`\nBuild with WITH_FUNCTION_NAMES=yes to see them.`
	);
}
if (consoleLines.length) {
	console.log('\nbrowser console:');
	for (const line of consoleLines.slice(0, 20)) console.log(`  ${line}`);
}
