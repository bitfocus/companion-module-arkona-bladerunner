import { describe, expect, it, vi } from 'vitest'
import { WATCH_OPTS, watchKeyword, watchRowName } from '../watch.js'

function self() {
	return { log: vi.fn(), scheduleDefinitionRefresh: vi.fn() } as any
}

describe('watchKeyword', () => {
	it('requests an initial value and collects the watcher', async () => {
		const watcher = { unwatch: vi.fn() }
		const watch = vi.fn(async (handler: (value: number) => void) => {
			handler(42)
			return watcher
		})
		const apply = vi.fn()
		const collect = vi.fn()
		await watchKeyword(self(), 'answer', { watch } as any, apply, collect)
		expect(watch).toHaveBeenCalledWith(apply, WATCH_OPTS)
		expect(apply).toHaveBeenCalledWith(42)
		expect(collect).toHaveBeenCalledWith(watcher)
	})

	it('isolates an unsupported keyword without rejecting discovery', async () => {
		const instance = self()
		await expect(
			watchKeyword(
				instance,
				'missing',
				{ watch: vi.fn().mockRejectedValue(new Error('unsupported')) },
				vi.fn(),
				vi.fn(),
			),
		).resolves.toBeUndefined()
		expect(instance.log).toHaveBeenCalledWith('debug', expect.stringContaining('missing'))
	})
})

describe('watchRowName', () => {
	it('applies fallback names and refreshes definitions only for changes', async () => {
		let handler!: (value: unknown) => void
		const instance = self()
		const apply = vi.fn()
		await watchRowName(
			instance,
			'row_1',
			{ raw: { watch: vi.fn(async (_path, callback) => ((handler = callback), { unwatch: vi.fn() } as any)) } },
			'Fallback',
			apply,
			vi.fn(),
		)
		handler('   ')
		handler('Fallback')
		handler(' Program ')
		expect(apply.mock.calls).toEqual([['Fallback'], ['Program']])
		expect(instance.scheduleDefinitionRefresh).toHaveBeenCalledTimes(2)
	})
})
