import { InstanceStatus } from '@companion-module/base'
import * as VAPI from 'vapi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BladeConnection } from '../vm.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

function root() {
	const vm = Object.create(VAPI.AT1130.Root.prototype) as VAPI.AT1130.Root
	const close = vi.fn(async () => undefined)
	Object.assign(vm, {
		raw: {
			build_info: { hardware_model: 'AT1130' },
			place_towel: vi.fn(async () => undefined),
		},
		close,
	})
	return { vm, close }
}

function harness(open: any, onConnected: (vm: VAPI.AT1130.Root) => Promise<void> = async () => undefined) {
	const self = {
		config: { host: '10.0.0.1', port: 80, protocol: 'ws', towel: 'companion', username: '' },
		secrets: { password: '' },
		log: vi.fn(),
		updateStatus: vi.fn(),
		onConnected: vi.fn(onConnected),
	}
	return { self, connection: new BladeConnection(self as any, open) }
}

afterEach(() => vi.useRealTimers())

describe('BladeConnection lifecycle', () => {
	it('closes and ignores an open superseded by disconnect', async () => {
		const opening = deferred<VAPI.AT1130.Root>()
		const { vm, close } = root()
		const { self, connection } = harness(async () => await opening.promise)
		const connecting = connection.connect()
		const disconnecting = connection.disconnect()

		opening.resolve(vm)
		await Promise.all([connecting, disconnecting])

		expect(close).toHaveBeenCalledOnce()
		expect(connection.vm).toBeNull()
		expect(self.onConnected).not.toHaveBeenCalled()
	})

	it('ignores socket events belonging to a superseded attempt', async () => {
		const first = deferred<VAPI.AT1130.Root>()
		let firstHandler: ((event: any) => void) | undefined
		const { self, connection } = harness(async (options: any) => {
			firstHandler = options.event_handler
			return await first.promise
		})
		const connecting = connection.connect()
		const disconnecting = connection.disconnect()
		first.resolve(root().vm)
		await Promise.all([connecting, disconnecting])
		self.updateStatus.mockClear()

		firstHandler?.({ event_type: 'unexpected-close' })

		expect(self.updateStatus).not.toHaveBeenCalled()
	})

	it('waits for active discovery to unwind before disconnect resolves', async () => {
		const discovery = deferred<void>()
		const { vm } = root()
		const { connection } = harness(
			async () => vm,
			async () => await discovery.promise,
		)
		const connecting = connection.connect()
		await vi.waitFor(() => expect(connection.vm).toBe(vm))
		let disconnected = false
		const disconnecting = connection.disconnect().then(() => {
			disconnected = true
		})
		await Promise.resolve()
		expect(disconnected).toBe(false)

		discovery.resolve()
		await Promise.all([connecting, disconnecting])
		expect(disconnected).toBe(true)
	})

	it('retries a failed initial open after the backoff', async () => {
		vi.useFakeTimers()
		const { vm } = root()
		const open = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(vm)
		const { self, connection } = harness(open)
		await connection.connect()
		expect(self.updateStatus).toHaveBeenCalledWith(InstanceStatus.ConnectionFailure, 'offline')

		await vi.advanceTimersByTimeAsync(5000)
		await vi.waitFor(() => expect(connection.vm).toBe(vm))
		expect(open).toHaveBeenCalledTimes(2)
		await connection.disconnect()
	})
})
