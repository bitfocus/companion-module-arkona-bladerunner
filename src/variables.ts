import type { CompanionVariableDefinition, CompanionVariableValue } from '@companion-module/base'
import type * as VAPI from 'vapi'
import type { ModuleInstance } from './main.js'
import { watchIssues } from './issues.js'
import { RestartableTimer } from './timers.js'
import { watchAll, watchKeyword, type Watchable } from './watch.js'

/**
 * Temperatures worth surfacing, out of the ~20 the AT1130 reports.
 *
 * Each entry is [variable id, device keyword, variable name, short label for a button].
 */
export const TEMPERATURES = [
	['temp_cpu', 'cpu', 'CPU temperature (°C)', 'CPU'],
	['temp_cpu_module', 'cpu_module', 'CPU module temperature (°C)', 'CPU Mod'],
	['temp_fpga_core', 'fpga_int_core', 'FPGA core temperature (°C)', 'FPGA'],
	['temp_fpga_sodimm', 'fpga_sodimm', 'FPGA SODIMM temperature (°C)', 'SODIMM'],
	['temp_ioboard', 'ioboard', 'IO board temperature (°C)', 'IO Board'],
	['temp_fan_in_1', 'fan1_in', 'Air intake temperature, right (°C)', 'Intake R'],
	['temp_fan_in_2', 'fan2_in', 'Air intake temperature, left (°C)', 'Intake L'],
] as const

/**
 * The FPGA and CPU supply rails, in volts.
 *
 * Each entry is [variable id, device keyword, variable name].
 */
export const POWER_RAILS = [
	['power_0v9', 'p0v9_b', 'FPGA 0.9 V rail (V)'],
	['power_1v2_hbm', 'p1v2_hbm', 'HBM 1.2 V rail (V)'],
	['power_1v8', 'p1v8', '1.8 V rail (V)'],
	['power_5v0', 'p5v0', '5 V rail (V)'],
] as const

/**
 * ECC counters, per memory.
 *
 * Correctable errors are normal in small numbers and worth trending; an uncorrectable one is a
 * reason to take the Blade out of service, which is why they are separate variables.
 */
export const ECC_MEMORIES = [
	['cpu_internal', 'CPU Internal'],
	['cpu_memory', 'CPU Memory'],
] as const

/**
 * Coalesces variable updates.
 *
 * The Blade pushes `uptime` and `load_avg` about once a second, and each keyword's handler fires
 * independently. Batching turns a tick into one `setVariableValues` call.
 */
export class VariableBatcher {
	readonly #self: ModuleInstance
	#pending: Record<string, CompanionVariableValue | undefined> = {}
	readonly #timer = new RestartableTimer()

	constructor(self: ModuleInstance) {
		this.#self = self
	}

	set(variableId: string, value: CompanionVariableValue | undefined): void {
		this.#pending[variableId] = value
		this.#timer.coalesce(100, () => this.flush())
	}

	flush(): void {
		this.#timer.cancel()
		if (Object.keys(this.#pending).length === 0) return
		const values = this.#pending
		this.#pending = {}
		this.#self.setVariableValues(values)
	}

	dispose(): void {
		this.#timer.cancel()
		this.#pending = {}
	}
}

/** `90061` -> `1d 01:01:01`. */
export function formatUptime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds))
	const days = Math.floor(total / 86400)
	const hours = Math.floor((total % 86400) / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const secs = total % 60
	const clock = [hours, minutes, secs].map((n) => String(n).padStart(2, '0')).join(':')
	return days > 0 ? `${days}d ${clock}` : clock
}

/**
 * Most of the Blade's sensor readings are `null | number` - null meaning "no sensor" or "not read
 * yet", which is not the same as zero and must not render as one. A PSU with no feed genuinely
 * reports 0 V, and that has to stay distinguishable from a PSU that is not there.
 */
export function formatNullable(value: number | boolean | string | null | undefined, digits = 1): string {
	if (value === null || value === undefined) return ''
	if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(digits)
	return String(value)
}

/** Fan and PSU counts vary by chassis, so definitions are built once the tables have been read. */
export interface TableCounts {
	fans: number[]
	psus: number[]
}

export function SystemVariableDefinitions(counts: TableCounts): CompanionVariableDefinition[] {
	return [
		{ variableId: 'device_type', name: 'Device Type' },
		{ variableId: 'device_serial', name: 'Device Serial Number' },
		{ variableId: 'device_unique_id', name: 'Device Unique ID' },
		{ variableId: 'board_location', name: 'Board Location in Frame' },
		{ variableId: 'short_desc', name: 'Description (from the Blade Web UI)' },
		{ variableId: 'sw_version', name: 'Software Version' },
		{ variableId: 'sw_build_date', name: 'Software Build Date' },
		{ variableId: 'booted_partition', name: 'Booted Partition' },
		{ variableId: 'selected_fpga', name: 'Loaded FPGA Personality' },

		{ variableId: 'uptime', name: 'Uptime (formatted)' },
		{ variableId: 'uptime_seconds', name: 'Uptime (seconds)' },
		{ variableId: 'load_avg_1', name: 'Load Average, 1 Minute' },
		{ variableId: 'load_avg_5', name: 'Load Average, 5 Minutes' },
		{ variableId: 'load_avg_15', name: 'Load Average, 15 Minutes' },
		{ variableId: 'free_ram_mb', name: 'Free Memory (MB)' },
		{ variableId: 'procs', name: 'Running Processes' },
		{ variableId: 'num_cores', name: 'Active CPU Cores' },

		...TEMPERATURES.map(([variableId, , name]) => ({ variableId, name })),
		{ variableId: 'overtemperature_time', name: 'Accumulated Over-temperature Time' },
		{ variableId: 'fanspeed_profile', name: 'Fan Speed Profile' },

		...POWER_RAILS.map(([variableId, , name]) => ({ variableId, name })),

		...ECC_MEMORIES.flatMap(([key, label]) => [
			{ variableId: `ecc_${key}_correctable`, name: `ECC - ${label} Correctable Errors` },
			{ variableId: `ecc_${key}_uncorrectable`, name: `ECC - ${label} Uncorrectable Errors` },
		]),

		...counts.fans.flatMap((i) => [
			{ variableId: `fan_${i}_id`, name: `Fan ${i} - Identifier` },
			{ variableId: `fan_${i}_speed`, name: `Fan ${i} - Speed (RPM)` },
		]),

		...counts.psus.flatMap((i) => [
			{ variableId: `psu_${i}_on`, name: `PSU ${i} - On` },
			{ variableId: `psu_${i}_vin`, name: `PSU ${i} - Input Voltage (V)` },
			{ variableId: `psu_${i}_iin`, name: `PSU ${i} - Input Current (A)` },
			{ variableId: `psu_${i}_temp`, name: `PSU ${i} - Hotspot Temperature (°C)` },
		]),
	]
}

/** Read the fan and PSU tables to learn how many rows this chassis actually has. */
export async function readTableCounts(vm: VAPI.AT1130.Root): Promise<TableCounts> {
	const [fans, psus] = await Promise.all([vm.system.fan_speed.allocated_indices(), vm.system.psu.allocated_indices()])
	return { fans, psus }
}

/**
 * Subscribe every system variable.
 *
 * `ensure_initial_read` makes each watch deliver a current value immediately, so there is no window
 * where a variable exists but reads empty. Watchers are handed to the connection, which tears them
 * down.
 */
export async function subscribeSystemVariables(
	self: ModuleInstance,
	vm: VAPI.AT1130.Root,
	counts: TableCounts,
): Promise<void> {
	const sys = vm.system
	const batcher = self.variables

	/**
	 * One subscription may feed several variables - `uptime` and `load_avg` each push about once a
	 * second, so watching them once per derived variable would multiply that traffic for nothing.
	 */
	const pending: Array<Promise<void>> = []
	const watch = <T>(label: string, keyword: Watchable<T>, apply: (payload: T) => void): void => {
		pending.push(watchKeyword(self, label, keyword, apply, (w) => self.connection.track(w)))
	}

	const watchOne = <T>(
		variableId: string,
		keyword: Watchable<T>,
		format: (payload: T) => CompanionVariableValue | undefined,
	): void => watch(variableId, keyword, (payload) => batcher.set(variableId, format(payload)))

	// Identity. Static for the life of the connection, so read once rather than watch - except the
	// description, which an operator can change from the web UI while we are connected.
	const identity: Array<[string, () => Promise<CompanionVariableValue | undefined>]> = [
		['device_type', async () => await sys.device.info.type.read()],
		['device_serial', async () => await sys.device.info.serial.read()],
		['device_unique_id', async () => await sys.unique_id.read()],
		['board_location', async () => await sys.board_location.read()],
		['booted_partition', async () => await sys.booted_partition.read()],
		['selected_fpga', async () => formatNullable(await sys.selected_fpga.read())],
		// `booted` reads back a SWVersion subtree whose own fields are keywords needing a second read.
		['sw_version', async () => formatNullable(await (await sys.partitions.booted.read())?.version.read())],
		['sw_build_date', async () => formatNullable(await (await sys.partitions.booted.read())?.timestamp.read())],
	]
	// Read concurrently. A one-shot read is a full round trip to the device - about half a second
	// each - whereas registering a watch is essentially free, so these reads dominate connect time
	// if they are awaited one at a time.
	await Promise.all(
		identity.map(async ([variableId, read]) => {
			try {
				batcher.set(variableId, await read())
			} catch (e: any) {
				self.log('debug', `Could not read ${variableId}: ${e?.message ?? e}`)
			}
		}),
	)

	watchOne('short_desc', sys.usrinfo.short_desc, (v) => v)

	// Load and memory. `uptime` arrives as a Duration; `freeram` is already in MB, not bytes.
	watch('sysinfo.uptime', sys.sysinfo.uptime, (v) => {
		batcher.set('uptime', formatUptime(v.s()))
		batcher.set('uptime_seconds', Math.floor(v.s()))
	})
	watch('sysinfo.load_avg', sys.sysinfo.load_avg, (v) => {
		batcher.set('load_avg_1', formatNullable(v[0], 2))
		batcher.set('load_avg_5', formatNullable(v[1], 2))
		batcher.set('load_avg_15', formatNullable(v[2], 2))
	})
	watchOne('free_ram_mb', sys.sysinfo.freeram, (v) => Math.round(v))
	watchOne('procs', sys.sysinfo.procs, (v) => v)
	watchOne('num_cores', sys.sysinfo.num_cores, (v) => formatNullable(v))

	for (const [variableId, keyword] of TEMPERATURES) {
		watchOne(variableId, sys.temperature[keyword], (v) => formatNullable(v))
	}
	watchOne('overtemperature_time', sys.temperature.accumulated_overtemperature_time, (v) => formatNullable(v, 0))
	watchOne('fanspeed_profile', sys.temperature.current_fanspeed_profile, (v) => formatNullable(v, 0))
	// The device's own view of whether it is too hot, rather than this module guessing a threshold.
	pending.push(watchIssues(self, 'temperature', 'Temperature', sys.temperature.issues, (w) => self.connection.track(w)))

	for (const [variableId, keyword] of POWER_RAILS) {
		watchOne(variableId, sys.power[keyword], (v) => formatNullable(v, 2))
	}

	for (const [key] of ECC_MEMORIES) {
		const ecc = sys.ecc[key]
		watchOne(`ecc_${key}_correctable`, ecc.ce_count, (v) => formatNullable(v, 0))
		watchOne(`ecc_${key}_uncorrectable`, ecc.ue_count, (v) => formatNullable(v, 0))
	}

	for (const i of counts.fans) {
		const fan = sys.fan_speed.row(i)
		watchOne(`fan_${i}_id`, fan.id, (v) => v)
		watchOne(`fan_${i}_speed`, fan.speed, (v) => formatNullable(v, 0))
	}

	for (const i of counts.psus) {
		const psu = sys.psu.row(i)
		watchOne(`psu_${i}_on`, psu.on, (v) => formatNullable(v))
		watchOne(`psu_${i}_vin`, psu.vin, (v) => formatNullable(v))
		watchOne(`psu_${i}_iin`, psu.iin, (v) => formatNullable(v, 2))
		watchOne(`psu_${i}_temp`, psu.temp_hotspot, (v) => formatNullable(v))
	}

	await watchAll(pending)
	batcher.flush()
}
