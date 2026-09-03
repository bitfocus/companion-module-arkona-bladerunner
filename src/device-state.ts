import type { TableCounts } from './variables.js'

interface Clearable {
	clear(): void
}

/** The device-derived state that must not survive a host or credential change. */
export interface DeviceStateOwner {
	clocks: Clearable
	rtp: Clearable
	processors: Clearable
	issues: Clearable
	tableCounts: TableCounts
	identifyActive: boolean
}

export function clearDeviceState(owner: DeviceStateOwner): void {
	owner.clocks.clear()
	owner.rtp.clear()
	owner.processors.clear()
	owner.issues.clear()
	owner.tableCounts = { fans: [], psus: [] }
	owner.identifyActive = false
}
