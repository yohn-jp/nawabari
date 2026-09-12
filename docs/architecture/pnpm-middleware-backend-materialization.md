# Deterministic RTK and pnpm Middleware Backend Materialization

Issue #309 supplies the exact backend material required by the provider in
Issue #306. It does not expose a host `pnpm` command, discover a host command,
or install anything during session launch.

## Contract

- RTK requirement: `rtk-pnpm-middleware`, package `rtk`, version `0.45.0`.
- Real pnpm requirement: `pnpm-pinned-backend`, package `pnpm`, version
  `11.18.0`.
- Backend provider identities: `rtk-pnpm` and `pnpm-real-backend`.
- Backend targets supplied to #306:
  `/runtime/pnpm-middleware/rtk` and
  `/runtime/pnpm-middleware/pnpm/bin/pnpm.mjs`.
- The public `/nawabari/bin/pnpm` launcher and its `proxy` binding belong to
  #306. #309 returns the two exact backend descriptors that its
  `materializePnpmMiddleware()` accepts.

## Immutable materialization sources

The two versions are not selected from one floating Nixpkgs channel. Each is
resolved through #291 with its own immutable Nixpkgs revision and `--offline`
`path-info` query:

- RTK: `github:NixOS/nixpkgs/bb92730f6e97ca1c19e285a872cdd62a1a25c467#rtk`.
  The Nixpkgs expression is `rtk` `0.45.0`, from `rtk-ai/rtk` tag `v0.45.0`,
  revision `refs/tags/v0.45.0`, source hash
  `sha256-weAyHM0nWLrM8JRbbXIfjUsHtAep3DOFyTO+M3BZ/iU=`, and Cargo hash
  `sha256-tgW6il/xLxt/xwhUBJ4MNVnk0JSZ7iFjJaEobj5+H4o=`.
- pnpm: `github:NixOS/nixpkgs/44cc5cdbf88deb1d20243d1d5e3b46ad008b6139#pnpm`.
  The Nixpkgs expression is `pnpm` `11.18.0`, from the immutable npm tarball
  `https://registry.npmjs.org/pnpm/-/pnpm-11.18.0.tgz`, with source hash
  `sha256-KcNcqNKih5iP3uPg824H2bk3g/VntXm3/Vt5ikVj3YE=`.

The Nix output's `bin/pnpm` is a symlink and is deliberately rejected as a
provider source. The exact regular executable is
`libexec/pnpm/bin/pnpm.mjs`. That file imports the bundled
`../dist/pnpm.mjs`, so the projection includes only that exact companion file
at `/runtime/pnpm-middleware/pnpm/dist/pnpm.mjs`; it never mounts the pnpm
output directory as a whole.

## Bounded projection and #306 handoff

`materializePnpmMiddlewareBackends()` calls #291 once per pinned backend,
combines the sorted closure paths, and validates them through the strict #288
projection contract. The returned projection contains one read-only bind for
each Nix store path and three additional file-level binds: the RTK executable,
the pnpm entrypoint, and its bundled `dist/pnpm.mjs` file. There is no
`/nix/store` root bind, directory crawl, PATH lookup, or executable alias.

The returned `rtk` and `real_pnpm` values have the exact shape expected by
#306:

```text
{ path: "/runtime/pnpm-middleware/rtk", source: "<rtk-root>/bin/rtk", provider: { id: "rtk-pnpm", requirement_id: "rtk-pnpm-middleware" } }
{ path: "/runtime/pnpm-middleware/pnpm/bin/pnpm.mjs", source: "<pnpm-root>/libexec/pnpm/bin/pnpm.mjs", provider: { id: "pnpm-real-backend", requirement_id: "pnpm-pinned-backend" } }
```

#293 can consume those exact file projections when a caller declares an
entrypoint. The backend materializer itself declares no public executable;
#306 adds the fixed launcher and `/nawabari/bin/pnpm` entrypoint.

## FHS behavior

#292's explicit FHS declaration contains a host path but no immutable package
source, package version, or provenance binding. The FHS route therefore fails
closed with the precise missing primitive `immutable package
source/version/provenance binding`; it never searches `/usr`, `/bin`, `/lib`,
or `/lib64` and never falls back to a host pnpm.

## Exact RTK `--version` evidence

```text
rtk 0.45.0
```

## Exact RTK `proxy --help` evidence

```text
Execute command without filtering but track usage

Usage: rtk proxy [OPTIONS] [ARGS]...

Arguments:
  [ARGS]...  Command and arguments to execute

Options:
      --ultra-compact  Ultra-compact mode: ASCII icons, inline format (Level 2 optimizations)
      --skip-env       Set SKIP_ENV_VALIDATION=1 for child processes (Next.js, tsc, lint, prisma)
  -h, --help           Print help
```

## Exact pnpm `--version` evidence

```text
11.18.0
```

## Exact pnpm `--help` evidence

```text
Version 11.18.0
Usage: pnpm [command] [flags]
       pnpm [ -h | --help | -v | --version ]

These are common pnpm commands used in various situations, use 'pnpm help -a' to list all commands

Manage your dependencies:
      add                  Installs a package and any packages that it depends
                           on. By default, any new package is installed as a
                           prod dependency
   i, install              Install all dependencies for a project
  ln, link                 Connect the local project to another one
  rm, remove               Removes packages from node_modules and from the
                           project's package.json
      unlink               Unlinks a package. Like yarn unlink but pnpm
                           re-installs the dependency after removing the
                           external link
  up, update               Updates packages to their latest version based on the
                           specified range

Review your dependencies:
      audit                Checks for known security issues with the installed
                           packages
  ls, list                 Print all the versions of packages that are
                           installed, as well as their dependencies, in a
                           tree-structure
      outdated             Check for outdated packages
      why                  Shows all packages that depend on the specified
                           package

Run your scripts:
      create               Create a project from a "create-*" or "@foo/create-*"
                           starter kit
      dlx                  Fetches a package from the registry without
                           installing it as a dependency, hot loads it, and runs
                           whatever default command binary it exposes
      exec                 Executes a shell command in scope of a project
      run                  Runs a defined package script

Other:
   c, config               Manage the pnpm configuration files
      init                 Create a package.json file
      publish              Publishes a package to the registry
      stage                Stage packages for publishing

Options:
  -r, --recursive          Run the command for each project in the workspace.
```

The exact observations above are checked against the same resolved Nix output
files in the opt-in backend conformance test. The check binds the executable
and pnpm bundle content hashes. It does not implement or execute the launcher;
#306 owns the end-to-end `/nawabari/bin/pnpm` → `rtk proxy` → exact pnpm path
after rebasing onto this backend contract.

The checked artifact hashes are:

- RTK `bin/rtk`: `44ef7ff8063d5ddc2ea68b1662c346129322cd2ce922440e53ca1486d1aa7ee0`.
- pnpm `libexec/pnpm/bin/pnpm.mjs`:
  `81c9d9b2d59db7fa00bb3456a6bacbc6c58b7aeb5c744727c4e167cdadd957e8`.
- pnpm `libexec/pnpm/dist/pnpm.mjs`:
  `d34a7b439643e7b8680a817387ec3692c7097ae7a85865c2c15ad6211143d506`.
