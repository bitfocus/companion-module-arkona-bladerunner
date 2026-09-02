import type * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'
import { activeSourceVariable, sourceIdForPath } from './routing.js'
import type { FlowLevel } from './routing.js'
import { watchAll, watchKeyword, watchRowName, type NamedRow } from './watch.js'

/**
 * A processing node - something that both consumes and produces essences.
 *
 * Nothing about routing changes for a processor: its inputs are ordinary destinations and its
 * outputs ordinary sources, so chaining is just two routes. `node` exists so an obviously cyclic
 * route (a node fed from its own output) can be refused.
 */
export interface ProcessorInput {
	id: string
	label: string
	node: string
	/** What follows the node's name in the label, so a rename relabels the whole node. */
	suffix: string
	/** Processors are single-level: a video delay takes video, an audio delay takes audio. */
	level: FlowLevel
	/** The keyword that names the routed essence. Written as a bare reference, not a TimedSource. */
	sourcePath: string | null
	sourceName: string | null
}

export interface ProcessorOutput {
	id: string
	label: string
	node: string
	suffix: string
	level: FlowLevel
	path: string
}

export class ProcessorState {
	readonly inputs = new Map<string, ProcessorInput>()
	readonly outputs = new Map<string, ProcessorOutput>()
	/** The current name of each node, which every label on it is built from. */
	readonly nodeNames = new Map<string, string>()

	clear(): void {
		this.inputs.clear()
		this.outputs.clear()
		this.nodeNames.clear()
	}
}

/** Apply a node's name to every label on it. Returns whether anything actually changed. */
export function applyNodeName(state: ProcessorState, node: string, name: string): boolean {
	if (state.nodeNames.get(node) === name) return false
	state.nodeNames.set(node, name)
	for (const entry of [...state.inputs.values(), ...state.outputs.values()]) {
		if (entry.node === node) entry.label = `${name}${entry.suffix}`
	}
	return true
}

export function mixerNode(index: number): string {
	return `mixer_${index}`
}

export function delayNode(index: number): string {
	return `delay_${index}`
}

export function audioDelayNode(index: number): string {
	return `audio_delay_${index}`
}

/**
 * Discover every processor input and output, and keep the input tallies up to date.
 *
 * All of these are the "direct essence reference" shape, unlike SDI and RTP endpoints which take a
 * TimedSource - see `resolveDestinationWriter`.
 */
export async function subscribeProcessors(self: ModuleInstance, vm: VAPI.AT1130.Root): Promise<void> {
	const state = self.processors
	const batcher = self.variables
	const collect = (w: VScript.Watcher): void => self.connection.track(w)

	// Each subscription is an independent round trip, so they are registered concurrently.
	const pending: Array<Promise<void>> = []
	const addInput = (
		id: string,
		suffix: string,
		node: string,
		level: FlowLevel,
		keyword: Parameters<typeof watchKeyword>[2],
	): void => {
		const label = `${state.nodeNames.get(node) ?? node}${suffix}`
		const entry: ProcessorInput = { id, label, node, suffix, level, sourcePath: null, sourceName: null }
		state.inputs.set(id, entry)
		pending.push(
			watchKeyword(
				self,
				`${id}.v_src`,
				keyword,
				(v: any) => {
					// A direct reference resolves straight to the essence, with no TimedSource wrapper.
					const path = v ? String(v.raw.kwl) : null
					entry.sourcePath = path
					const variable = activeSourceVariable(id, level)
					batcher.set(variable, sourceIdForPath(path, level) ?? '')
					self.checkFeedbacks('flow_routed')

					if (!v) {
						entry.sourceName = null
						batcher.set(`${variable}_label`, '')
						return
					}
					void v.brief
						.read()
						.then((brief: string) => {
							entry.sourceName = brief
							batcher.set(`${variable}_label`, brief)
						})
						.catch(() => batcher.set(`${variable}_label`, path ?? ''))
				},
				collect,
			),
		)
	}

	/**
	 * Track a node's name.
	 *
	 * The name is set from the fallback first so labels exist synchronously, then watched: renaming
	 * a delay in the device's web UI has to reach the choices and the label variables, not wait for
	 * the next reconnect.
	 */
	const nameNode = (node: string, fallback: string, row: NamedRow, label: string): void => {
		state.nodeNames.set(node, fallback)
		pending.push(
			watchRowName(
				self,
				label,
				row,
				(name) => {
					if (applyNodeName(state, node, name.trim() === '' ? fallback : name)) self.scheduleDefinitionRefresh()
				},
				collect,
			),
		)
	}

	const addOutput = (id: string, suffix: string, node: string, level: FlowLevel, path: string): void => {
		state.outputs.set(id, {
			id,
			label: `${state.nodeNames.get(node) ?? node}${suffix}`,
			node,
			suffix,
			level,
			path,
		})
	}

	const mixer = vm.video_mixer
	if (mixer) {
		for (const i of await mixer.instances.allocated_indices()) {
			const row = mixer.instances.row(i)
			const node = mixerNode(i)
			nameNode(node, `Mixer ${i}`, row, `${node}.row_name`)
			addInput(`${node}_a`, ' A', node, 'video', row.v_src0.status)
			addInput(`${node}_b`, ' B', node, 'video', row.v_src1.status)
			addInput(`${node}_key`, ' Key', node, 'video', row.luma_keyer.v_src.status)
			addOutput(`${node}_out`, ' Output', node, 'video', `video_mixer.instances[${i}].output`)
		}
	}

	const replay = vm.re_play?.video
	if (replay) {
		for (const i of await replay.delays.allocated_indices()) {
			const row = replay.delays.row(i)
			const node = delayNode(i)
			nameNode(node, `Delay ${i}`, row, `${node}.row_name`)
			// Inputs and outputs are separate tables on a delay, so they are indexed independently.
			for (const j of await row.inputs.allocated_indices()) {
				addInput(`${node}_in_${j}`, ` In ${j}`, node, 'video', row.inputs.row(j).v_src.status)
			}
			for (const k of await row.outputs.allocated_indices()) {
				addOutput(`${node}_out_${k}`, ` Out ${k}`, node, 'video', `re_play.video.delays[${i}].outputs[${k}].video`)
			}
		}

		for (const i of await replay.players.allocated_indices()) {
			const node = `player_${i}`
			nameNode(node, `Player ${i}`, replay.players.row(i), `${node}.row_name`)
			addOutput(`${node}_out`, ' Output', node, 'video', `re_play.video.players[${i}].output.video`)
		}
	}

	const audioReplay = vm.re_play?.audio
	if (audioReplay) {
		for (const i of await audioReplay.delays.allocated_indices()) {
			const row = audioReplay.delays.row(i)
			const node = audioDelayNode(i)
			nameNode(node, `Audio Delay ${i}`, row, `${node}.row_name`)
			// An audio delay has a single input subtree rather than a table of them.
			addInput(`${node}_in`, ' In', node, 'audio', row.inputs.a_src.status)
			for (const k of await row.outputs.allocated_indices()) {
				addOutput(`${node}_out_${k}`, ` Out ${k}`, node, 'audio', `re_play.audio.delays[${i}].outputs[${k}].audio`)
			}
		}
	}

	// The monitoring live view consumes video but produces nothing, so it is a destination only.
	if (vm.monitoring) {
		// The live view is not a table row, so its name is fixed.
		state.nodeNames.set('monitor', 'Monitoring Live View')
		addInput('monitor_live', '', 'monitor', 'video', vm.monitoring.live_view.v_src.status)
	}

	await watchAll(pending)
	self.log('info', `Processors: ${state.inputs.size} routable input(s), ${state.outputs.size} output(s)`)
	batcher.flush()
}
