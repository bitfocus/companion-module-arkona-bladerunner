# companion-module-arokona-blade

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE)

## Getting started

Executing a `yarn` command should perform all necessary steps to develop the module, if it does not then follow the steps below.

The module can be built once with `yarn build`. This should be enough to get the module to be loadable by companion.

While developing the module, by using `yarn dev` the compiler will be run in watch mode to recompile the files on change.

## Arkona SDK dependencies

`vapi` and `vscript` are not published to npm. They are installed directly from Arkona's public SDK
host as release tarballs:

| Package   | Version | Role                                                                      |
| --------- | ------- | ------------------------------------------------------------------------- |
| `vapi`    | 2.6.47  | typed overlay describing the VM state tree (`AT1130.Root`, `System`, …)   |
| `vscript` | 2.6.8   | the client itself: WebSocket transport, keyword read/watch, subscriptions |

`yarn.lock` records a checksum for each tarball, so the contents are pinned as firmly as a registry
dependency. The host is only contacted at install time — `companion-module-build` bundles both into
`dist/main.js`, so the distributed module has no runtime dependency on it.

To move to a different SDK release, bump the versions in the two URLs in `package.json` (the path is
`https://sdk.arkona-technologies.de/<pkg>@<version>/node/<pkg>.tar.gz`) and run `yarn install` to
refresh the lockfile checksums. The SDK version must match the BLADE//runner software version being
targeted.

`vutil` is Arkona-internal test tooling and is deliberately not a dependency of this module.

## Packaging

`build-config.cjs` turns webpack's module concatenation off for `yarn package`. With it on,
webpack 5.110 miscompiles the `new WebSocket(...)` call in vscript's `ws` adapter into
`(new moduleGetter())(url, …)`, so the packaged module could never open a socket and every
connection attempt failed with `S is not a constructor`. Only the packaged build was affected —
`dist/`, which `yarn dev` and the dev-module entrypoint use, is plain `tsc` output. Remove the
workaround once the upstream codegen is fixed.
