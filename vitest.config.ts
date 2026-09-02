import { defineConfig } from 'vitest/config'

// Without an explicit config here, vitest walks up and finds the Companion core repo's root
// config, whose projects (companion, webui, ...) do not exist in this module.
export default defineConfig({
	test: {
		include: ['src/**/*.spec.ts'],
	},
})
