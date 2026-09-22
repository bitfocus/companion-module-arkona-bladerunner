/**
 * webpack 5.110's CommonJS module concatenation miscompiles `new WebSocket(...)` inside vscript's
 * `ws` adapter: the imported binding becomes a module getter and the emitted `new getter()(url)`
 * parses as `(new getter())(url)`, so every connection attempt died with "S is not a constructor".
 * Concatenation only saves a little bundle size, so turn it off until the upstream codegen is fixed.
 */
class DisableModuleConcatenation {
	apply(compiler) {
		compiler.options.optimization.concatenateModules = false
	}
}

module.exports = {
	plugins: [new DisableModuleConcatenation()],
}
