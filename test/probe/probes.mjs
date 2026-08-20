/*
 * probes.mjs — the PHP snippets we run against a php-wasm build, and what
 * each one is supposed to prove.
 *
 * Each probe runs in its own browser page against its own PHP instance.  That
 * is not tidiness: creating several runtimes in one page exhausts memory and
 * the page dies in a way that looks exactly like a bug in the probe (the
 * evaluation promise is reported as garbage collected).  One runtime, one
 * page.
 *
 * `expect` is what a fixed build should do.  `known` records what the build
 * the site ships today actually does, so a run against the published package
 * reproduces the problem rather than merely failing.
 */

export const probes = [
	{
		name: 'baseline',
		what: 'PHP runs at all and reports its version',
		code: `<?php
			echo PHP_VERSION, "|", PHP_INT_MAX, "|", php_uname();
		`,
		expect: (r) => r.text.startsWith('8.'),
		known: 'works',
	},

	{
		name: 'fiber-start-suspend-resume',
		what: 'a Fiber starts, suspends, resumes and returns a value',
		code: `<?php
			$fiber = new Fiber(function (string $greeting): string {
				$received = Fiber::suspend($greeting . ' from inside');
				return 'returned ' . $received;
			});
			$suspendedWith = $fiber->start('hello');
			echo $suspendedWith, "\\n";
			$fiber->resume('the resume value');
			echo $fiber->getReturn(), "\\n";
			echo $fiber->isTerminated() ? 'terminated' : 'still running', "\\n";
		`,
		expect: (r) =>
			r.text.includes('hello from inside') &&
			r.text.includes('returned the resume value') &&
			r.text.includes('terminated'),
		known: 'aborts the runtime',
	},

	{
		name: 'fiber-suspend-from-nested-call',
		what: 'a Fiber suspends from several frames below its entry function',
		code: `<?php
			function level3(int $depth): string {
				return Fiber::suspend("suspended at depth $depth");
			}
			function level2(int $depth): string { return level3($depth + 1); }
			function level1(int $depth): string { return level2($depth + 1); }

			$fiber = new Fiber(function (): string {
				$a = level1(1);
				$b = level1(1);
				return "$a / $b";
			});
			echo $fiber->start(), "\\n";
			echo $fiber->resume('first'), "\\n";
			$fiber->resume('second');
			echo $fiber->getReturn(), "\\n";
		`,
		expect: (r) =>
			r.text.includes('suspended at depth 3') &&
			r.text.includes('first / second'),
		known: 'aborts the runtime',
	},

	{
		name: 'fiber-several-at-once',
		what: 'several Fibers are alive at the same time and interleave',
		code: `<?php
			$fibers = [];
			foreach (range(1, 5) as $n) {
				$fibers[$n] = new Fiber(function () use ($n): string {
					Fiber::suspend("fiber $n paused");
					Fiber::suspend("fiber $n paused again");
					return "fiber $n done";
				});
			}
			$out = [];
			foreach ($fibers as $fiber) { $out[] = $fiber->start(); }
			foreach ($fibers as $fiber) { $out[] = $fiber->resume(); }
			foreach ($fibers as $fiber) { $fiber->resume(); $out[] = $fiber->getReturn(); }
			echo implode("\\n", $out);
		`,
		expect: (r) =>
			r.text.includes('fiber 1 paused') &&
			r.text.includes('fiber 5 paused again') &&
			r.text.includes('fiber 5 done'),
		known: 'aborts the runtime',
	},

	{
		name: 'fiber-throw-and-catch',
		what: 'an exception thrown into a Fiber surfaces where PHP says it should',
		code: `<?php
			$fiber = new Fiber(function (): string {
				try {
					Fiber::suspend('waiting');
				} catch (RuntimeException $e) {
					return 'caught inside: ' . $e->getMessage();
				}
				return 'no exception';
			});
			echo $fiber->start(), "\\n";
			$fiber->throw(new RuntimeException('thrown in'));
			echo $fiber->getReturn(), "\\n";
		`,
		expect: (r) => r.text.includes('caught inside: thrown in'),
		known: 'aborts the runtime',
	},

	{
		name: 'instance-survives-a-fiber',
		what: 'the PHP instance still works after a Fiber has run',
		/*
		 * Measured against @php-wasm/web-8-5 3.1.50 on 2026-08-19: the second
		 * run does still work.  The Fiber abort loses that one run and its
		 * output, but the instance keeps answering, which is milder than
		 * expected and worth not regressing.  Kept as a guard rather than as
		 * evidence of the fix: the fiber probes above are the evidence.
		 */
		runs: [
			`<?php
				$fiber = new Fiber(function () { Fiber::suspend('paused'); return 'done'; });
				echo $fiber->start();
			`,
			`<?php echo "still alive: ", 2 + 2;`,
		],
		expect: (r) => r.runs?.[1]?.text?.includes('still alive: 4'),
		known: 'passes already: the abort loses the run, not the instance',
	},

	{
		name: 'loaded-extensions',
		what: 'which extensions the build carries',
		code: `<?php
			$loaded = get_loaded_extensions();
			sort($loaded);
			echo implode(',', $loaded);
		`,
		expect: (r) => r.text.includes('json'),
		known: '41 extensions; intl, gmp, sodium, pcntl, posix and sockets absent',
		report: (r) => {
			const loaded = r.text.split(',').map((s) => s.trim());
			const wanted = ['intl', 'gmp', 'sodium', 'pcntl', 'posix', 'sockets'];
			return {
				count: loaded.length,
				missing: wanted.filter((w) => !loaded.includes(w)),
			};
		},
	},

	{
		name: 'network-file-get-contents',
		what: 'an https read fails in a way PHP code can handle',
		code: `<?php
			$result = @file_get_contents('https://example.com');
			echo $result === false ? 'returned false' : 'returned ' . strlen($result) . ' bytes';
		`,
		expect: (r) => r.text.includes('returned false'),
		known: 'traps: Aborted(unreachable), taking the runtime with it',
	},

	{
		name: 'network-fsockopen',
		what: 'a socket connection fails in a way PHP code can handle',
		code: `<?php
			$handle = @fsockopen('example.com', 80, $errno, $errstr, 1);
			echo $handle === false ? "returned false ($errno)" : 'opened a socket';
		`,
		expect: (r) => r.text.includes('returned false'),
		known: 'traps: Aborted(unreachable)',
	},

	{
		name: 'network-curl',
		what: 'curl_exec fails in a way PHP code can handle',
		code: `<?php
			$handle = curl_init('https://example.com');
			curl_setopt($handle, CURLOPT_RETURNTRANSFER, true);
			curl_setopt($handle, CURLOPT_TIMEOUT, 2);
			$result = curl_exec($handle);
			echo $result === false ? 'returned false: ' . curl_error($handle) : 'fetched something';
		`,
		expect: (r) => r.text.includes('returned false'),
		known: 'traps: Aborted(unreachable), although the curl extension is loaded',
	},

	{
		name: 'process-functions-declared',
		what: 'whether PHP claims to have the process functions',
		code: `<?php
			foreach (['exec','shell_exec','system','passthru','proc_open','popen'] as $fn) {
				echo $fn, '=', function_exists($fn) ? 'declared' : 'absent', "\\n";
			}
		`,
		expect: () => true,
		known: 'all six are declared, so PHP code takes the branch that uses them',
		report: (r) => Object.fromEntries(
			r.text.trim().split('\n').map((line) => line.split('='))
		),
	},

	{
		name: 'process-popen',
		what: 'popen fails without killing the page',
		/*
		 * The worst of the failures measured: not an abort but the death of
		 * the browsing context.  Kept last, because a page that dies takes
		 * any probe sharing it down too.
		 */
		code: `<?php
			$handle = @popen('echo hello', 'r');
			echo $handle === false ? 'returned false' : 'opened a pipe';
		`,
		expect: (r) => r.text.includes('returned false'),
		known: 'kills the browser tab outright',
	},
];
