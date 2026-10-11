/* Hand-written config.h for building mosh's client core with emscripten (wasm32, musl libc).
   Only the macros the core sources (crypto, network, statesync, terminal, terminaloverlay, timestamp) test. */
#ifndef WEBMOSH_CONFIG_H
#define WEBMOSH_CONFIG_H

#define HAVE_CLOCK_GETTIME 1
#define HAVE_GETTIMEOFDAY 1
#define HAVE_ENDIAN_H 1
#define HAVE_DECL_BE64TOH 1
#define HAVE_DECL___BUILTIN_BSWAP64 1
#define HAVE_DECL___BUILTIN_CTZ 1
#define HAVE_DECL_FFS 1
#define HAVE_POSIX_MEMALIGN 1
#define HAVE_MEMORY 1
#define HAVE_STD_SHARED_PTR 1
#define HAVE_STRINGS_H 1
#define HAVE_SYS_UIO_H 1

/* AES for OCB comes from nettle (build/nettle-wasm) */
#define USE_NETTLE_AES 1

#define PACKAGE_STRING "mosh 1.4.0 (webmosh)"
#define BUILD_VERSION "webmosh"

#endif
