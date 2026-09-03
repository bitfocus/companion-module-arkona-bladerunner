import { describe, expect, it, vi } from 'vitest'
import { IssueState } from '../issues.js'
import { childIndices, ProcessorState, subscribeProcessors } from '../processors.js'

const self = { log: vi.fn() } as any

/** A minimal stand-in for the subtree description the device sends. */
function raw(children: Array<Record<string, any>>, indices: number[] = []) {
	return {
		kwl: 'splitter.instances[0]',
		backing_store: { table_indices: async () => indices },
		description: { children },
	}
}

// vapi's typed accessors assert the container type they were generated against, so a child that is
// an array on this firmware and a table in vapi throws on property access. Reading the schema the
// device actually sent is what keeps one mismatch from taking discovery down.
describe('childIndices', () => {
	it('reads a table through its row mask', async () => {
		const children = [{ container_type: 1, contents: { sys_name: 'outputs' } }]
		await expect(childIndices(self, raw(children, [0, 2]), 'outputs')).resolves.toEqual([0, 2])
	})

	it('treats an array as every index up to its capacity', async () => {
		const children = [{ container_type: 2, capacity: 3, contents: { sys_name: 'outputs' } }]
		await expect(childIndices(self, raw(children), 'outputs')).resolves.toEqual([0, 1, 2])
	})

	it('returns nothing for a child this firmware does not have', async () => {
		const children = [{ container_type: 1, contents: { sys_name: 'inputs' } }]
		await expect(childIndices(self, raw(children), 'outputs')).resolves.toEqual([])
		await expect(childIndices(self, { ...raw([]), description: {} } as any, 'outputs')).resolves.toEqual([])
	})

	it('is not defeated by a keyword of the same name', async () => {
		const children = [{ container_type: 4, contents: { sys_name: 'outputs' } }]
		await expect(childIndices(self, raw(children), 'outputs')).resolves.toEqual([])
	})

	it('reports an unreadable table as empty rather than throwing', async () => {
		const children = [{ container_type: 1, contents: { sys_name: 'outputs' } }]
		const broken = {
			...raw(children),
			backing_store: {
				table_indices: async () => {
					throw new Error('nope')
				},
			},
		}
		await expect(childIndices(self, broken as any, 'outputs')).resolves.toEqual([])
	})
})

describe('ProcessorState', () => {
	const output = {
		id: 'delay_0_out_0',
		node: 'delay_0',
		suffix: ' Out 0',
		level: 'video',
		path: 're_play.video.delays[0].outputs[0].video',
	} as const

	// The path index is how a tally turns a routed path back into a source ID, so it has to be
	// registered with the output rather than maintained alongside it.
	it('indexes an output by its path as well as its ID', () => {
		const state = new ProcessorState()
		state.addOutput(output)
		expect(state.outputsByPath.get(output.path)?.id).toBe('delay_0_out_0')
	})

	it('builds a label from the node name and the port suffix', () => {
		const state = new ProcessorState()
		state.addOutput(output)
		expect(state.label(output)).toBe('delay_0 Out 0')
		state.nodeNames.set('delay_0', 'ISO 1')
		expect(state.label(output)).toBe('ISO 1 Out 0')
	})

	it('offers discovered video mixers using their live row names', () => {
		const state = new ProcessorState()
		state.videoMixers.set(2, {
			index: 2,
			mode: 'MIXER',
			fader0: 0,
			fader1: 1,
			clip: -0.07,
			gain: 1.131,
			opacity: 1,
			invert: false,
		})
		expect(state.videoMixerChoices()).toEqual([{ id: 2, label: 'Mixer 2' }])
		state.nodeNames.set('mixer_2', 'Main Mix')
		expect(state.videoMixerChoices()).toEqual([{ id: 2, label: 'Main Mix' }])
	})

	it('forgets everything when cleared', () => {
		const state = new ProcessorState()
		state.addOutput(output)
		state.nodeNames.set('delay_0', 'ISO 1')
		state.clear()
		expect(state.outputs.size).toBe(0)
		expect(state.outputsByPath.size).toBe(0)
		expect(state.nodeNames.size).toBe(0)
		expect(state.videoMixers.size).toBe(0)
	})
})

function keyword(initial: unknown) {
	return {
		watch: vi.fn(async (handler: (value: unknown) => void) => {
			handler(initial)
			return { unwatch: vi.fn() }
		}),
	}
}

function processorHarness() {
	const values: Record<string, unknown> = {}
	const instance = {
		processors: new ProcessorState(),
		issues: new IssueState(),
		variables: {
			set: vi.fn((id: string, value: unknown) => void (values[id] = value)),
			flush: vi.fn(),
		},
		connection: { track: vi.fn() },
		checkFeedbacks: vi.fn(),
		scheduleDefinitionRefresh: vi.fn(),
		log: vi.fn(),
	} as any
	return { instance, values }
}

function named(name: string) {
	return {
		raw: {
			watch: vi.fn(async (_path: unknown, handler: (value: unknown) => void) => {
				handler(name)
				return { unwatch: vi.fn() }
			}),
		},
	}
}

describe('subscribeProcessors', () => {
	it('discovers a mixer, publishes live state, and retains working route writers', async () => {
		const h = processorHarness()
		const writeA = vi.fn().mockResolvedValue(undefined)
		const source = {
			raw: { kwl: 'i_o_module.input[7].sdi.output.video' },
			brief: { read: vi.fn().mockResolvedValue('Camera 7') },
		}
		const demand = (initial: unknown, write = vi.fn().mockResolvedValue(undefined)) => ({
			status: keyword(initial),
			command: { write },
		})
		const row = {
			...named('Program Mixer'),
			issues: keyword({}),
			v_src0: demand(source, writeA),
			v_src1: demand(null),
			mode: keyword('MIXER'),
			mixer: {
				fader0: { current: keyword(0.25) },
				fader1: { current: keyword(0.75) },
			},
			luma_keyer: {
				v_src: demand(null),
				clip: keyword(-0.1),
				gain: keyword(1.2),
				opacity: { current: keyword(0.8) },
				invert: keyword(true),
			},
		}

		await subscribeProcessors(h.instance, {
			video_mixer: { instances: { allocated_indices: async () => [2], row: () => row } },
		} as any)
		await Promise.resolve()

		expect(h.instance.processors.nodeNames.get('mixer_2')).toBe('Program Mixer')
		expect(h.instance.processors.outputs.get('mixer_2_out')?.path).toBe('video_mixer.instances[2].output')
		expect(h.instance.processors.videoMixers.get(2)).toMatchObject({
			mode: 'MIXER',
			fader0: 0.25,
			fader1: 0.75,
			clip: -0.1,
			gain: 1.2,
			opacity: 0.8,
			invert: true,
		})
		expect(h.values.dest_mixer_2_a_video_active_source).toBe('sdi_in_7')
		expect(h.values.dest_mixer_2_a_video_active_source_label).toBe('Camera 7')
		await h.instance.processors.inputs.get('mixer_2_a')!.write(source, 0)
		expect(writeA).toHaveBeenCalledWith(source)
		expect(h.instance.variables.flush).toHaveBeenCalledOnce()
		expect(h.instance.log).toHaveBeenCalledWith('info', 'Processors: 3 routable input(s), 1 output(s)')
	})

	it('maps shuffler channels and writes only the selected slot', async () => {
		const h = processorHarness()
		const write = vi.fn().mockResolvedValue(undefined)
		const essence = {
			raw: { kwl: 'i_o_module.input[1].sdi.output.audio' },
			brief: { read: vi.fn().mockResolvedValue('SDI 1 Audio') },
			channels: { reference_to_index: vi.fn((channel: number) => `channel-${channel}`) },
		}
		const channelRef = { enclosing_subtree: essence, index: 6 }
		const aSrc = {
			status: { ...keyword([channelRef, null]), read: vi.fn().mockResolvedValue([channelRef, null]) },
			command: { write },
		}
		await subscribeProcessors(h.instance, {
			audio_shuffler: {
				instances: { allocated_indices: async () => [3], row: () => ({ ...named('Shuffle'), a_src: aSrc }) },
			},
		} as any)
		await Promise.resolve()

		expect(h.instance.processors.inputs.get('shuffler_3_in_0')).toMatchObject({
			takesChannel: true,
			sourceChannel: 6,
			sourceName: 'SDI 1 Audio ch 6',
		})
		expect(h.values.dest_shuffler_3_in_0_audio_active_source_channel).toBe(6)
		await h.instance.processors.inputs.get('shuffler_3_in_1')!.write(essence, 9)
		expect(essence.channels.reference_to_index).toHaveBeenCalledWith(9)
		expect(write).toHaveBeenCalledWith({ 1: 'channel-9' })
		await h.instance.processors.inputs.get('shuffler_3_in_0')!.write(null, 0)
		expect(write).toHaveBeenCalledWith({ 0: null })
	})

	it('isolates a broken processor family while discovering the others', async () => {
		const h = processorHarness()
		const gainWrite = vi.fn().mockResolvedValue(undefined)
		await subscribeProcessors(h.instance, {
			splitter: {
				instances: { allocated_indices: vi.fn().mockRejectedValue(new Error('schema mismatch')) },
			},
			audio_gain: {
				instances: {
					allocated_indices: async () => [4],
					row: () => ({
						...named('Commentary Gain'),
						a_src: { status: keyword(null), command: { write: gainWrite } },
					}),
				},
			},
		} as any)

		expect(h.instance.processors.inputs.has('gain_4_in')).toBe(true)
		expect(h.instance.processors.outputs.has('gain_4_out')).toBe(true)
		expect(h.instance.log).toHaveBeenCalledWith('warn', 'Skipping splitters: schema mismatch')
	})
})
