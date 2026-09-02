import { describe, expect, it } from 'vitest'
import { adjustedTarget, mixerTransitionTarget } from '../actions.js'

describe('mixerTransitionTarget', () => {
	it('maps A and B to the confirmed fader end stops', () => {
		expect(mixerTransitionTarget('a', 0.8)).toBe(0)
		expect(mixerTransitionTarget('b', 0.2)).toBe(1)
	})

	it('toggles away from the nearest end, including during a transition', () => {
		expect(mixerTransitionTarget('toggle', 0)).toBe(1)
		expect(mixerTransitionTarget('toggle', 0.49)).toBe(1)
		expect(mixerTransitionTarget('toggle', 0.5)).toBe(0)
		expect(mixerTransitionTarget('toggle', 1)).toBe(0)
	})
})

describe('adjustedTarget', () => {
	it('sets absolute values and clamps them to the device range', () => {
		expect(adjustedTarget('set', 0.75, null, 0, 1)).toBe(0.75)
		expect(adjustedTarget('set', 2, null, 0, 1)).toBe(1)
	})

	it('applies positive and negative increments', () => {
		expect(adjustedTarget('adjust', 0.1, 0.5, 0, 1)).toBe(0.6)
		expect(adjustedTarget('adjust', -0.2, 0.5, 0, 1)).toBe(0.3)
	})

	it('clamps adjustments and requires a current value', () => {
		expect(adjustedTarget('adjust', 0.5, 0.8, 0, 1)).toBe(1)
		expect(adjustedTarget('adjust', -0.5, 0.2, 0, 1)).toBe(0)
		expect(adjustedTarget('adjust', 0.1, null, 0, 1)).toBeNull()
	})
})
