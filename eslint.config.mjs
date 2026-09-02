import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const config = await generateEslintConfig({
	enableTypescript: true,
	// vendor/ and docs/ are Arkona-supplied release artifacts; scripts/ is throwaway tooling.
	ignores: ['vendor/**', 'docs/**', 'dist/**', 'scripts/**', 'vitest.config.ts'],
})

export default [
	...config,
	{
		// Tests are excluded from the build, so importing devDependencies is correct here.
		files: ['src/**/*.spec.ts'],
		rules: {
			'n/no-unpublished-import': 'off',
		},
	},
]
