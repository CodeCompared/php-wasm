#!/usr/bin/env bash
#
# Builds the php-wasm web/asyncify binary out of the upstream/ checkout,
# with this project's changes applied.
#
# Why not `npm run recompile:php:web:asyncify:8.5`
# ------------------------------------------------
# That script goes through nx, which needs the whole WordPress Playground
# monorepo installed, and through a version-refresh step that reaches out to
# php.net and quietly moves to whatever 8.5.x came out most recently.  Neither
# is wanted here: the point of comparison is the exact build the site ships
# today, PHP 8.5.8 from @php-wasm/web-8-5 3.1.50, so the version is pinned and
# the docker command is spelled out.  Every argument below is the value
# packages/php-wasm/compile/build.js computes for a web asyncify build.
#
# What comes out
#   upstream/packages/php-wasm/web-builds/8-5/asyncify/
#     php_8_5.js         the loader
#     8_5_8/php_8_5.wasm the binary
#
# Usage:
#   scripts/build-php.sh              # build PHP 8.5.8, web, asyncify
#   PHP_VERSION=8.5.8 scripts/build-php.sh
#
# Docker must be running.  The first build takes a long time; later ones reuse
# Docker's layer cache, and a change to the Asyncify only-list or to
# ucontext-emscripten.c only re-runs the final link, because both come after
# the `emmake make` layer in the Dockerfile.

set -euo pipefail

cd "$(dirname "$0")/.."
project_root="$PWD"

php_version="${PHP_VERSION:-8.5.8}"
php_ref="${PHP_REF:-php-$php_version}"

compile_dir="$project_root/upstream/packages/php-wasm/compile"
version_dir="$(cut -d. -f1 <<<"$php_version")-$(cut -d. -f2 <<<"$php_version")"
output_dir="$project_root/upstream/packages/php-wasm/web-builds/$version_dir/asyncify"

if [ ! -d "$compile_dir" ]; then
	echo "upstream/ is not checked out.  Run:" >&2
	echo "  git clone --depth 1 https://github.com/WordPress/wordpress-playground.git upstream" >&2
	exit 1
fi

if ! docker info >/dev/null 2>&1; then
	echo "Docker is not running." >&2
	exit 1
fi

# Keep the shim in the build tree identical to the one under src/, so there is
# only ever one copy to edit.
cp "$project_root/src/ucontext-emscripten.c" \
	"$project_root/src/ucontext-emscripten.h" \
	"$compile_dir/php/"

echo "Building the emscripten base image (cached after the first run)..."
make -C "$compile_dir" base-image

echo "Building PHP $php_version for the web, asyncify variant..."
cd "$compile_dir"

docker build \
	-f php/Dockerfile .. \
	--tag=php-wasm \
	--progress=plain \
	--build-arg "PHP_VERSION=$php_version" \
	--build-arg "PHP_REF=$php_ref" \
	--build-arg "OPENSSL_VERSION=1.1.0h" \
	--build-arg "WITH_FILEINFO=yes" \
	--build-arg "WITH_LIBXML=yes" \
	--build-arg "WITH_SOAP=yes" \
	--build-arg "WITH_LIBZIP=yes" \
	--build-arg "WITH_EXIF=yes" \
	--build-arg "WITH_GD=yes" \
	--build-arg "WITH_MBSTRING=yes" \
	--build-arg "WITH_MBREGEX=yes" \
	--build-arg "WITH_CLI_SAPI=yes" \
	--build-arg "WITH_OPENSSL=yes" \
	--build-arg "WITH_NODEFS=no" \
	--build-arg "WITH_CURL=yes" \
	--build-arg "WITH_SQLITE=yes" \
	--build-arg "WITH_SOURCEMAPS=no" \
	--build-arg "OUTPUT_DIR_ON_HOST=$output_dir" \
	--build-arg "WITH_DEBUG=no" \
	--build-arg "DEBUG_DWARF_COMPILATION_DIR=$compile_dir/.." \
	--build-arg "WITH_ICONV=yes" \
	--build-arg "WITH_MYSQL=no" \
	--build-arg "WITH_WS_NETWORKING_PROXY=yes" \
	--build-arg "WITH_IMAGICK=no" \
	--build-arg "EMSCRIPTEN_ENVIRONMENT=web" \
	--build-arg "WITH_JSPI=no" \
	--build-arg "WITH_OPCACHE=yes" \
	--build-arg "STACK_SIZE=1MB"

echo "Extracting the build..."
mkdir -p "$output_dir"
docker run --name php-wasm-tmp --rm -v "$output_dir:/output" php-wasm \
	sh -c 'cp -r /root/output/* /output/'

echo
echo "Built into $output_dir:"
ls -la "$output_dir"
