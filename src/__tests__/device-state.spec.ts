import { describe, expect, it, vi } from 'vitest'
import { clearDeviceState } from '../device-state.js'

describe('clearDeviceState', () => {
	it('clears every topology source before connecting to a replacement Blade', () => {
		const owner = {
			clocks: { clear: vi.fn() },
			rtp: { clear: vi.fn() },
			processors: { clear: vi.fn() },
			issues: { clear: vi.fn() },
			tableCounts: { fans: [0, 1], psus: [0] },
			identifyActive: true,
		}

		clearDeviceState(owner)

		expect(owner.clocks.clear).toHaveBeenCalledOnce()
		expect(owner.rtp.clear).toHaveBeenCalledOnce()
		expect(owner.processors.clear).toHaveBeenCalledOnce()
		expect(owner.issues.clear).toHaveBeenCalledOnce()
		expect(owner.tableCounts).toEqual({ fans: [], psus: [] })
		expect(owner.identifyActive).toBe(false)
	})
})
