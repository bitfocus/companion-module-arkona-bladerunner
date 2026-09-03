import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import type * as VAPI from 'vapi'
import { UpdateActions } from './actions.js'
import { ClockState, ClockVariableDefinitions, subscribeClocks } from './clocks.js'
import { ProcessorState, subscribeProcessors } from './processors.js'
import { RtpState, RtpVariableDefinitions, subscribeRtp } from './rtp.js'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { clearDeviceState } from './device-state.js'
import { IoManager, IoVariableDefinitions } from './io.js'
import { IssueState, IssueVariableDefinitions, publishIssues } from './issues.js'
import { UpdatePresets } from './presets.js'
import {
	activeSourceVariable,
	buildRegistry,
	flowRegistryValues,
	FlowVariableDefinitions,
	isBreakaway,
	type FlowRegistry,
	type FlowStateSources,
} from './routing.js'
import { UpgradeScripts } from './upgrades.js'
import { BladeConnection } from './vm.js'
import {
	readTableCounts,
	subscribeSystemVariables,
	SystemVariableDefinitions,
	VariableBatcher,
	type TableCounts,
} from './variables.js'

/** Before the tables have been read we still want the fixed variables to exist. */
const NO_TABLES: TableCounts = { fans: [], psus: [] }

export class ModuleInstance extends InstanceBase<ModuleConfig, ModuleSecrets> {
	config!: ModuleConfig // Setup in init()
	secrets!: ModuleSecrets // Setup in init()

	readonly connection = new BladeConnection(this)
	readonly variables = new VariableBatcher(this)
	readonly io = new IoManager()
	readonly clocks = new ClockState()
	readonly rtp = new RtpState()
	readonly processors = new ProcessorState()
	readonly issues = new IssueState()
	/** Mirrors the front panel blink keyword, so the identify feedback evaluates synchronously. */
	identifyActive = false

	#refreshTimer: NodeJS.Timeout | null = null

	/** Everything `buildRegistry` projects the routing graph from. */
	get flowState(): FlowStateSources {
		return { io: this.io.state, rtp: this.rtp, processors: this.processors }
	}

	/** Fan/PSU row counts, discovered at connect. Read by the variable and preset builders. */
	tableCounts: TableCounts = NO_TABLES

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets

		this.rebuildDefinitions()

		// Deliberately not awaited. Connecting and discovering the device is well over a hundred
		// sequential round trips, which overruns Companion's init timeout and gets the instance
		// killed and restarted. The connection reports its own progress through the instance status.
		this.startConnecting()
	}

	/** Begin connecting in the background, keeping any failure out of an unhandled rejection. */
	startConnecting(): void {
		this.connection.connect().catch((e: any) => {
			this.log('error', `Connection failed: ${e?.message ?? e}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, e?.message ?? 'Connection failed')
		})
	}

	/**
	 * Rebuild everything whose shape depends on what the device turned out to have - fan and PSU
	 * counts, and which BNCs are inputs or outputs. Called again after each discovery, including
	 * when a BNC changes direction while we are connected.
	 */
	rebuildDefinitions(): void {
		const registry = buildRegistry(this.flowState)
		this.setVariableDefinitions([
			...SystemVariableDefinitions(this.tableCounts),
			...IoVariableDefinitions(this.io.state),
			...FlowVariableDefinitions(registry),
			...ClockVariableDefinitions(this.clocks),
			...RtpVariableDefinitions(this.rtp),
			...IssueVariableDefinitions(this.issues),
		])
		UpdateActions(this, registry)
		UpdateFeedbacks(this, registry)
		UpdatePresets(this)

		// Definitions and values are published separately, and a value set before its definition
		// exists is dropped. Discovery necessarily rebuilds definitions after some values have been
		// published, so every rebuild re-publishes what the registry currently knows.
		this.#publishFlowValues(registry)
		// Issue values are published by their own watches, so a rebuild has to republish them too.
		publishIssues(this)
	}

	/**
	 * Rebuild definitions soon, coalescing a burst into one pass.
	 *
	 * Renaming a row on the device changes a label that appears in dropdown choices, in variable
	 * names and in the `src_label_*`/`dst_label_*` values, so the whole rebuild is the update - but
	 * discovery delivers every name at once, and each rebuild republishes every variable.
	 */
	scheduleDefinitionRefresh(): void {
		if (this.#refreshTimer) return
		this.#refreshTimer = setTimeout(() => {
			this.#refreshTimer = null
			this.rebuildDefinitions()
		}, 250)
	}

	#publishFlowValues(registry: FlowRegistry): void {
		for (const [variableId, value] of Object.entries(flowRegistryValues(registry))) {
			this.variables.set(variableId, value)
		}
		for (const destination of registry.destinations.values()) {
			// Only the levels the destination carries have variables defined for them.
			for (const level of destination.levels) {
				const variable = activeSourceVariable(destination.id, level)
				this.variables.set(variable, destination.active[level].sourceId ?? '')
				this.variables.set(`${variable}_label`, destination.active[level].label ?? '')
				if (destination.takesChannel) {
					this.variables.set(`${variable}_channel`, destination.active[level].channel ?? '')
				}
			}
			if (destination.levels.length > 1) {
				this.variables.set(`dest_${destination.id}_breakaway`, String(isBreakaway(destination)))
			}
		}
		this.variables.flush()
	}

	/** Called by the connection once a socket is up. */
	async onConnected(vm: VAPI.AT1130.Root): Promise<void> {
		try {
			this.tableCounts = await readTableCounts(vm)
		} catch (e: any) {
			this.log('warn', `Could not enumerate fan/PSU tables: ${e?.message ?? e}`)
			this.tableCounts = NO_TABLES
		}

		this.rebuildDefinitions()
		await subscribeSystemVariables(this, vm, this.tableCounts)
		await subscribeClocks(this, vm)
		await subscribeRtp(this, vm)
		await subscribeProcessors(this, vm)
		// Clock discovery adds the genlock variables and the time-source choices, so definitions are
		// rebuilt once more before the IO layer registers its own.
		this.rebuildDefinitions()
		await this.io.start(this, vm)

		// Everything is discovered by now, so one last rebuild publishes any tally that landed before
		// its variable was defined.
		this.rebuildDefinitions()
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
		this.#refreshTimer = null
		this.clocks.clear()
		this.rtp.clear()
		this.processors.clear()
		this.issues.clear()
		this.io.dispose()
		this.variables.dispose()
		await this.connection.disconnect()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
		this.#refreshTimer = null
		this.io.dispose()
		await this.connection.disconnect()
		clearDeviceState(this)
		this.config = config
		this.secrets = secrets
		this.rebuildDefinitions()
		this.updateStatus(InstanceStatus.Connecting)
		this.startConnecting()
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}
}

runEntrypoint(ModuleInstance, UpgradeScripts)
