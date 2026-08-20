#!/usr/bin/env bash
#
# Builds and runs test/prototype/fiber-prototype.c against the Asyncify
# configurations that matter, and checks each one behaves as expected.
#
# Why more than one configuration
# -------------------------------
# php-wasm does not link with plain Asyncify.  To keep the download near
# 21 MB it passes
#
#     -s ASYNCIFY=1 -s ASYNCIFY_IGNORE_INDIRECT=1 -s ASYNCIFY_ONLY=[...]
#
# where the only-list names about two thousand functions one at a time.
# IGNORE_INDIRECT tells Asyncify that a call through a function pointer never
# needs to be paused, and the only-list tells it that no function outside the
# list needs to be paused either.  Both assumptions are false for fibers
# unless the whole call path is named, so a shim that passes under plain
# Asyncify proves nothing about the shipped build.  The third case below is
# the one that decides whether this work can ship.
#
# How the only-list is built
# --------------------------
# By asking Asyncify.  Building once with -s ASYNCIFY_ADVISE=1 makes it print
# every function it would instrument and why; those names become the list for
# the next build.  The same trick produces the list for the real PHP build,
# where writing it out by hand is not realistic.
#
# Usage: scripts/check-prototype.sh
# Exits non-zero if a configuration does not behave as expected.

set -uo pipefail

cd "$(dirname "$0")/.."

out_dir="${TMPDIR:-/tmp}/php-wasm-prototype"
mkdir -p "$out_dir"

sources=(src/ucontext-emscripten.c test/prototype/fiber-prototype.c)
common=(-O1 -I src -sASSERTIONS=1 -sEXIT_RUNTIME=1)

failures=0

# ---------------------------------------------------------------------------
# Ask Asyncify which functions it would instrument, and turn that into a list.
# ---------------------------------------------------------------------------

echo "Asking Asyncify which functions need instrumenting..."
emcc "${common[@]}" -sASYNCIFY=1 -sASYNCIFY_ADVISE=1 \
	-o "$out_dir/advise.js" "${sources[@]}" \
	>"$out_dir/advise.txt" 2>&1

only_list=$(node scripts/asyncify-advise-list.mjs "$out_dir/advise.txt" \
	--exclude emscripten_fiber_swap)

if [ -z "$only_list" ]; then
	echo "could not read an only-list out of $out_dir/advise.txt"
	exit 1
fi

echo "  $(tr -cd , <<<"$only_list" | wc -c | tr -d ' ') functions named"

# ---------------------------------------------------------------------------

# run_case <name> <expected: pass|fail> <emcc flags...>
run_case() {
	local name="$1" expected="$2"
	shift 2
	local js="$out_dir/${name}.js"
	local actual

	printf '\n=== %s (expected to %s) ===\n' "$name" "$expected"

	if ! emcc "${common[@]}" "$@" -o "$js" "${sources[@]}" \
		2>"$out_dir/${name}.build.log"; then
		echo "BUILD FAILED"
		sed -n '1,20p' "$out_dir/${name}.build.log"
		failures=$((failures + 1))
		return
	fi

	if node "$js" >"$out_dir/${name}.run.log" 2>&1; then
		actual=pass
	else
		actual=fail
	fi

	sed -n '1,12p' "$out_dir/${name}.run.log"

	if [ "$actual" = "$expected" ]; then
		echo "-> $actual, as expected"
	else
		echo "-> $actual, but $expected was expected"
		failures=$((failures + 1))
	fi
}

# Plain Asyncify instruments everything it cannot prove safe, so the shim
# should simply work.  If this one breaks, the shim itself is wrong.
run_case "plain-asyncify" pass -sASYNCIFY=1

# IGNORE_INDIRECT with nothing else is expected to fail, and it is worth
# keeping as a case so the reason stays visible: a fiber is entered through a
# function pointer, so with indirect calls declared safe there is nothing left
# to pause the fiber's entry frame, and the first suspend walks off the end of
# a stack that was never saved.  php-wasm never links this way; the only-list
# below is what rescues it.
run_case "ignore-indirect-alone" fail -sASYNCIFY=1 -sASYNCIFY_IGNORE_INDIRECT=1

# This is php-wasm's shape, and the case that decides whether the shim can
# ship.  Naming a function in the only-list instruments it even though it is
# reached indirectly, which is exactly the escape hatch the fiber entry needs.
run_case "php-wasm-shape" pass \
	-sASYNCIFY=1 -sASYNCIFY_IGNORE_INDIRECT=1 "-sASYNCIFY_ONLY=[$only_list]"

# The same list without IGNORE_INDIRECT, to show the only-list is doing the
# work rather than the two flags happening to cancel out.
run_case "only-list-alone" pass -sASYNCIFY=1 "-sASYNCIFY_ONLY=[$only_list]"

printf '\n'
if [ "$failures" -ne 0 ]; then
	echo "$failures configuration(s) behaved unexpectedly"
	exit 1
fi
echo "every configuration behaved as expected"
