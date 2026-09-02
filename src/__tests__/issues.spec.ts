import { describe, expect, it, vi } from 'vitest'
import {
	ANY_ISSUE_SOURCE,
	formatIssueLabel,
	issueChoices,
	IssueState,
	IssueVariableDefinitions,
	publishIssues,
	watchIssues,
} from '../issues.js'

/** Enough of the module for the issue layer: somewhere to put variables, and a watch that fires. */
function harness() {
	const values: Record<string, unknown> = {}
	const self = {
		issues: new IssueState(),
		variables: { set: (id: string, value: unknown) => void (values[id] = value) },
		checkFeedbacks: vi.fn(),
		log: vi.fn(),
	} as any
	let deliver: (payload: unknown) => void = () => undefined
	const keyword = {
		watch: async (handler: (payload: unknown) => void) => {
			deliver = handler
			return {} as any
		},
	}
	return { self, values, keyword, deliver: (payload: unknown) => deliver(payload) }
}

describe('watchIssues', () => {
	it('registers a source before the device has said anything', async () => {
		const h = harness()
		await watchIssues(h.self, 'mixer_0', 'Mixer 0', h.keyword, () => undefined)
		expect(h.self.issues.sources.get('mixer_0')).toEqual({ id: 'mixer_0', label: 'Mixer 0', flags: [] })
		expect(h.self.issues.active()).toEqual([])
	})

	// The payload is a flat record of named booleans, and only the raised ones are the report.
	it('publishes the raised flags and clears them again', async () => {
		const h = harness()
		await watchIssues(h.self, 'delay_0', 'Delay 0', h.keyword, () => undefined)

		h.deliver({ missing_timesource: true, out_of_memory: false, out_of_readers: true })
		expect(h.self.issues.sources.get('delay_0')?.flags).toEqual(['missing_timesource', 'out_of_readers'])
		expect(h.values.issues_delay_0).toBe('Missing timesource, Out of readers')
		expect(h.values.issues_delay_0_count).toBe(2)
		expect(h.values.issues_count).toBe(2)
		expect(h.values.issues_sources).toBe('Delay 0')
		expect(h.self.checkFeedbacks).toHaveBeenCalledWith('has_issues')

		h.deliver({ missing_timesource: false, out_of_readers: false })
		expect(h.self.issues.active()).toEqual([])
		expect(h.values.issues_delay_0).toBe('')
		expect(h.values.issues_count).toBe(0)
	})

	it('survives a device that reports nothing at all', async () => {
		const h = harness()
		await watchIssues(h.self, 'player_0', 'Player 0', h.keyword, () => undefined)
		h.deliver(null)
		expect(h.values.issues_player_0).toBe('')
	})
})

describe('IssueState', () => {
	function stateWith(flags: string[]): IssueState {
		const state = new IssueState()
		state.sources.set('mixer_0', { id: 'mixer_0', label: 'Mixer 0', flags })
		state.sources.set('delay_0', { id: 'delay_0', label: 'Delay 0', flags: [] })
		return state
	}

	it('reports only the sources currently unhappy', () => {
		expect(
			stateWith(['cycle_detected'])
				.active()
				.map((s) => s.id),
		).toEqual(['mixer_0'])
		expect(stateWith([]).active()).toEqual([])
	})

	// A node renamed on the device has to keep its issue variable readable.
	it('follows a rename', () => {
		const state = stateWith([])
		state.relabel('mixer_0', 'PGM Mix')
		expect(state.sources.get('mixer_0')?.label).toBe('PGM Mix')
		expect(() => state.relabel('nonsense', 'x')).not.toThrow()
	})

	it('defines two variables per source plus the device-wide summary', () => {
		const ids = IssueVariableDefinitions(stateWith([])).map((v) => v.variableId)
		expect(ids).toEqual([
			'issues_count',
			'issues_sources',
			'issues_mixer_0',
			'issues_mixer_0_count',
			'issues_delay_0',
			'issues_delay_0_count',
		])
	})

	it('offers every source plus the catch-all as choices', () => {
		expect(issueChoices(stateWith([])).map((c) => c.id)).toEqual([ANY_ISSUE_SOURCE, 'mixer_0', 'delay_0'])
	})

	it('republishes what the sources currently hold', () => {
		const h = harness()
		h.self.issues.sources.set('mixer_0', { id: 'mixer_0', label: 'Mixer 0', flags: ['cycle_detected'] })
		publishIssues(h.self)
		expect(h.values.issues_mixer_0).toBe('Cycle detected')
		expect(h.values.issues_sources).toBe('Mixer 0')
	})
})

describe('formatIssueLabel', () => {
	it('reads as words on a button', () => {
		expect(formatIssueLabel('missing_or_uncalibrated_t_src')).toBe('Missing or uncalibrated t src')
	})

	// The SDI wording predates this layer and is what operators already read on those buttons.
	it('keeps the wording the device-specific flags already had', () => {
		expect(formatIssueLabel('missing_t_src')).toBe('Missing time source')
	})
})
