import { describe, expect, it, vi } from 'vitest'
import { childIndices, ProcessorState } from '../processors.js'

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

	it('forgets everything when cleared', () => {
		const state = new ProcessorState()
		state.addOutput(output)
		state.nodeNames.set('delay_0', 'ISO 1')
		state.clear()
		expect(state.outputs.size).toBe(0)
		expect(state.outputsByPath.size).toBe(0)
		expect(state.nodeNames.size).toBe(0)
	})
})
