import type * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'
import { activeSourceVariable, sourceIdForPath } from './routing.js'
import { watchAll, watchKeyword } from './watch.js'

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
	/** The keyword that names the routed essence. Written as a bare reference, not a TimedSource. */
	sourcePath: string | null
	sourceName: string | null
}

export interface ProcessorOutput {
	id: string
	label: string
	node: string
	path: string
}

export class ProcessorState {
	readonly inputs = new Map<string, ProcessorInput>()
	readonly outputs = new Map<string, ProcessorOutput>()

	clear(): void {
		this.inputs.clear()
		this.outputs.clear()
	}
}

export function mixerNode(index: number): string {
	return `mixer_${index}`
}

export function delayNode(index: number): string {
	return `delay_${index}`
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
	const addInput = (id: string, label: string, node: string, keyword: Parameters<typeof watchKeyword>[2]): void => {
		const entry: ProcessorInput = { id, label, node, sourcePath: null, sourceName: null }
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
					const variable = activeSourceVariable(id, 'video')
					batcher.set(variable, sourceIdForPath(path, 'video') ?? '')
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

	const mixer = vm.video_mixer
	if (mixer) {
		for (const i of await mixer.instances.allocated_indices()) {
			const row = mixer.instances.row(i)
			const node = mixerNode(i)
			let name = `Mixer ${i}`
			try {
				const rowName = (await row.row_name()).trim()
				if (rowName !== '') name = rowName
			} catch {
				// Fall back to the index; a missing row name is not worth failing discovery over.
			}
			addInput(`${node}_a`, `${name} A`, node, row.v_src0.status)
			addInput(`${node}_b`, `${name} B`, node, row.v_src1.status)
			addInput(`${node}_key`, `${name} Key`, node, row.luma_keyer.v_src.status)
			state.outputs.set(`${node}_out`, {
				id: `${node}_out`,
				label: `${name} Output`,
				node,
				path: `video_mixer.instances[${i}].output`,
			})
		}
	}

	const replay = vm.re_play?.video
	if (replay) {
		for (const i of await replay.delays.allocated_indices()) {
			const row = replay.delays.row(i)
			const node = delayNode(i)
			let name = `Delay ${i}`
			try {
				const rowName = (await row.row_name()).trim()
				if (rowName !== '') name = rowName
			} catch {
				// As above.
			}
			// Inputs and outputs are separate tables on a delay, so they are indexed independently.
			for (const j of await row.inputs.allocated_indices()) {
				addInput(`${node}_in_${j}`, `${name} In ${j}`, node, row.inputs.row(j).v_src.status)
			}
			for (const k of await row.outputs.allocated_indices()) {
				state.outputs.set(`${node}_out_${k}`, {
					id: `${node}_out_${k}`,
					label: `${name} Out ${k}`,
					node,
					path: `re_play.video.delays[${i}].outputs[${k}].video`,
				})
			}
		}

		for (const i of await replay.players.allocated_indices()) {
			const node = `player_${i}`
			state.outputs.set(`${node}_out`, {
				id: `${node}_out`,
				label: `Player ${i} Output`,
				node,
				path: `re_play.video.players[${i}].output.video`,
			})
		}
	}

	// The monitoring live view consumes video but produces nothing, so it is a destination only.
	if (vm.monitoring) {
		addInput('monitor_live', 'Monitoring Live View', 'monitor', vm.monitoring.live_view.v_src.status)
	}

	await watchAll(pending)
	self.log('info', `Processors: ${state.inputs.size} routable input(s), ${state.outputs.size} output(s)`)
	batcher.flush()
}
