import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatNullable, formatUptime, VariableBatcher } from '../variables.js'
import { describeWriteError, writeBlockedReason } from '../vm.js'

afterEach(() => vi.useRealTimers())

describe('VariableBatcher', () => {
	it('coalesces updates and keeps the latest value for each variable', async () => {
		vi.useFakeTimers()
		const setVariableValues = vi.fn()
		const batcher = new VariableBatcher({ setVariableValues } as any)
		batcher.set('one', 1)
		batcher.set('two', 2)
		batcher.set('one', 3)
		expect(setVariableValues).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(100)

		expect(setVariableValues).toHaveBeenCalledOnce()
		expect(setVariableValues).toHaveBeenCalledWith({ one: 3, two: 2 })
	})

	it('flushes immediately and cancels the scheduled batch', async () => {
		vi.useFakeTimers()
		const setVariableValues = vi.fn()
		const batcher = new VariableBatcher({ setVariableValues } as any)
		batcher.set('one', 1)
		batcher.flush()
		expect(setVariableValues).toHaveBeenCalledWith({ one: 1 })

		await vi.advanceTimersByTimeAsync(100)
		expect(setVariableValues).toHaveBeenCalledOnce()
	})

	it('drops pending values when disposed', async () => {
		vi.useFakeTimers()
		const setVariableValues = vi.fn()
		const batcher = new VariableBatcher({ setVariableValues } as any)
		batcher.set('old_device', 1)
		batcher.dispose()

		await vi.advanceTimersByTimeAsync(100)
		expect(setVariableValues).not.toHaveBeenCalled()
	})
})

describe('formatUptime', () => {
	it('renders a clock below a day', () => {
		expect(formatUptime(0)).toBe('00:00:00')
		expect(formatUptime(61)).toBe('00:01:01')
		expect(formatUptime(3661)).toBe('01:01:01')
		expect(formatUptime(86399)).toBe('23:59:59')
	})

	it('prefixes whole days', () => {
		expect(formatUptime(86400)).toBe('1d 00:00:00')
		expect(formatUptime(90061)).toBe('1d 01:01:01')
		expect(formatUptime(864000)).toBe('10d 00:00:00')
	})

	it('truncates fractional seconds rather than rounding up', () => {
		expect(formatUptime(59.9)).toBe('00:00:59')
	})

	it('clamps nonsense to zero', () => {
		expect(formatUptime(-5)).toBe('00:00:00')
	})
})

describe('formatNullable', () => {
	// The distinction that matters: a missing sensor must not read as 0 degrees.
	it('renders null and undefined as empty, not zero', () => {
		expect(formatNullable(null)).toBe('')
		expect(formatNullable(undefined)).toBe('')
	})

	it('keeps a real zero', () => {
		expect(formatNullable(0)).toBe('0')
	})

	it('leaves integers alone and fixes the precision of fractions', () => {
		expect(formatNullable(42)).toBe('42')
		expect(formatNullable(42.567)).toBe('42.6')
		expect(formatNullable(1.234, 2)).toBe('1.23')
	})

	it('passes through booleans and strings', () => {
		expect(formatNullable(true)).toBe('true')
		expect(formatNullable(false)).toBe('false')
		expect(formatNullable('AVP_100GbE')).toBe('AVP_100GbE')
	})
})

describe('describeWriteError', () => {
	// Reads are unaffected by a towel, so without this the symptom is "variables work, actions do not".
	it('turns a towel rejection into an instruction', () => {
		const message = describeWriteError(
			new Error("Unable to access i_o_module.configuration[7] at 10.0.0.1: blocked by towel 'other-session'"),
		)
		expect(message).toContain("towel 'other-session'")
		expect(message).toContain('Towel config field')
	})

	it('passes other failures through unchanged', () => {
		expect(describeWriteError(new Error('connection reset'))).toBe('connection reset')
		expect(describeWriteError('plain string')).toBe('plain string')
	})
})

describe('writeBlockedReason', () => {
	const vmWithTowel = (held: string) => ({ raw: { current_towel: { value: held } } }) as any

	it('blocks when no towel is configured, since the Blade will silently decline the write', () => {
		expect(writeBlockedReason('', vmWithTowel(''))).toContain('no Towel configured')
	})

	it('blocks when someone else holds the towel, and names them', () => {
		expect(writeBlockedReason('mine', vmWithTowel('theirs'))).toContain("'theirs'")
	})

	it('allows when we hold the towel, or when none is placed yet', () => {
		expect(writeBlockedReason('mine', vmWithTowel('mine'))).toBeNull()
		expect(writeBlockedReason('mine', vmWithTowel(''))).toBeNull()
	})

	it('blocks when disconnected', () => {
		expect(writeBlockedReason('mine', null)).toContain('not connected')
	})
})
