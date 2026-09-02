import { describe, expect, it, vi } from 'vitest'
import { UpdatePresets } from '../presets.js'
import { ProcessorState } from '../processors.js'

function mixerState() {
	const processors = new ProcessorState()
	processors.nodeNames.set('mixer_2', 'Main Mix')
	processors.videoMixers.set(2, {
		index: 2,
		mode: 'MIXER',
		fader0: 0,
		fader1: 0,
		clip: 0,
		gain: 1,
		opacity: 1,
		invert: false,
	})
	return processors
}

describe('video mixer presets', () => {
	it('builds discovered, named mixer controls with matching feedbacks', () => {
		const setPresetDefinitions = vi.fn()
		UpdatePresets({
			processors: mixerState(),
			tableCounts: { fans: [], psus: [] },
			clocks: { genlocks: new Map() },
			io: { state: { inputs: new Map(), outputs: new Map() } },
			setPresetDefinitions,
		} as any)

		const presets = setPresetDefinitions.mock.calls[0][0]
		expect(presets.mixer_2_header.name).toBe('Main Mix')
		expect(presets.mixer_2_cut_a.steps[0].down[0]).toEqual({
			actionId: 'video_mixer_fader',
			options: { mixer: 2, input: 'a', style: 'cut', duration: 1000 },
		})
		expect(presets.mixer_2_cut_a.feedbacks[0]).toMatchObject({
			feedbackId: 'video_mixer_input',
			options: { mixer: 2, input: 'a' },
		})
		expect(presets.mixer_2_mode_luma_keyer.feedbacks[0]).toMatchObject({
			feedbackId: 'video_mixer_mode',
			options: { mixer: 2, mode: 'LUMA_KEYER' },
		})
		expect(presets.mixer_2_key_on).toBeUndefined()
		expect(presets.mixer_2_key_invert).toBeUndefined()
		expect(presets.mixer_2_clip_up).toBeUndefined()
		expect(presets.mixer_2_gain_up).toBeUndefined()
		expect(presets.mixer_2_key_up).toBeUndefined()
	})

	it('does not offer mixer presets before a mixer is discovered', () => {
		const setPresetDefinitions = vi.fn()
		UpdatePresets({
			processors: new ProcessorState(),
			tableCounts: { fans: [], psus: [] },
			clocks: { genlocks: new Map() },
			io: { state: { inputs: new Map(), outputs: new Map() } },
			setPresetDefinitions,
		} as any)
		const presets = setPresetDefinitions.mock.calls[0][0]
		expect(Object.keys(presets).some((id) => id.startsWith('mixer_'))).toBe(false)
	})
})
