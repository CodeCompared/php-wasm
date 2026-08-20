#!/usr/bin/env node
/*
 * asyncify-advise-list.mjs — turn an Asyncify advice log into an only-list.
 *
 * Building with `-s ASYNCIFY_ADVISE=1` makes Emscripten print one line per
 * function it intends to instrument, like
 *
 *     [asyncify] swapcontext can change the state due to emscripten_fiber_swap
 *
 * Feed that output in and this prints the names as a comma-separated list of
 * quoted strings, ready to drop into `-s ASYNCIFY_ONLY=[...]`.
 *
 * The parsing is deliberately forgiving.  Emscripten writes those lines from
 * Python while Binaryen writes others straight to the same stream, so the two
 * interleave and a name can end up split across a line boundary, like
 *
 *     dynCall_vi[asyncify] dynCall_iiii can change the state due to ...
 *      can change the state due to initial scan
 *
 * A naive line-by-line reader silently drops `dynCall_vi` there, and a
 * missing name does not fail the build — it fails at run time, much later,
 * as an `unreachable` trap with no explanation.  So this reads the log as one
 * stream instead of as lines.
 *
 * Usage:
 *   node scripts/asyncify-advise-list.mjs advise.log
 *   node scripts/asyncify-advise-list.mjs advise.log --exclude emscripten_fiber_swap
 *   ... | node scripts/asyncify-advise-list.mjs
 *
 * Options:
 *   --exclude NAME   leave NAME out (repeatable).  Imports belong here:
 *                    they are named in ASYNCIFY_IMPORTS, not the only-list.
 *   --plain          print one name per line instead of a quoted list.
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const excluded = new Set();
let plain = false;
let file = null;

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--exclude') {
		excluded.add(argv[++i]);
	} else if (argv[i] === '--plain') {
		plain = true;
	} else if (argv[i] === '--help' || argv[i] === '-h') {
		console.log(
			'usage: asyncify-advise-list.mjs [advise.log] [--exclude NAME]... [--plain]'
		);
		process.exit(0);
	} else {
		file = argv[i];
	}
}

const log = readFileSync(file ?? 0, 'utf8');

/*
 * Drop the marker wherever it appears — including in the middle of a line,
 * which is where the interleaving puts it — and treat what is left as one
 * continuous stream, so a name split by a stray newline is still found.
 */
const stream = log.split('[asyncify]').join(' ').replace(/\s+/g, ' ');

const names = new Set();
const pattern = /([A-Za-z_$][A-Za-z0-9_$.]*) can change the state/g;
let match;
while ((match = pattern.exec(stream)) !== null) {
	const name = match[1];
	if (!excluded.has(name)) {
		names.add(name);
	}
}

if (names.size === 0) {
	console.error(
		'asyncify-advise-list: found no function names — was the build run with -s ASYNCIFY_ADVISE=1?'
	);
	process.exit(1);
}

const sorted = [...names].sort();
process.stdout.write(
	plain
		? sorted.join('\n') + '\n'
		: sorted.map((n) => `"${n}"`).join(',') + '\n'
);
