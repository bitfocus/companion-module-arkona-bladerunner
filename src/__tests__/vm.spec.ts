import { InstanceStatus } from '@companion-module/base'
import * as VAPI from 'vapi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BladeConnection, describeConnectError } from '../vm.js'

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
		expect(self.updateStatus).toHaveBeenCalledWith(InstanceStatus.ConnectionFailure, 'Connection failed')
		expect(self.log).toHaveBeenCalledWith('error', expect.stringContaining('10.0.0.1:80'))

		await vi.advanceTimersByTimeAsync(5000)
		await vi.waitFor(() => expect(connection.vm).toBe(vm))
		expect(open).toHaveBeenCalledTimes(2)
		await connection.disconnect()
	})

	it('logs an unchanged failure once however long the retry loop runs', async () => {
		vi.useFakeTimers()
		const open = vi.fn().mockRejectedValue(new Error('offline'))
		const { self, connection } = harness(open)
		await connection.connect()

		await vi.advanceTimersByTimeAsync(20000)

		expect(open.mock.calls.length).toBeGreaterThan(2)
		expect(self.log.mock.calls.filter(([level]) => level === 'error')).toHaveLength(1)
		await connection.disconnect()
	})

	it('logs again when the failure changes, and after a connection has come and gone', async () => {
		vi.useFakeTimers()
		const { vm } = root()
		const open = vi
			.fn()
			.mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
			.mockRejectedValueOnce(Object.assign(new Error('unreachable'), { code: 'EHOSTUNREACH' }))
			.mockResolvedValueOnce(vm)
		const { self, connection } = harness(open)
		await connection.connect()
		await vi.advanceTimersByTimeAsync(5000)
		await vi.advanceTimersByTimeAsync(5000)
		await vi.waitFor(() => expect(connection.vm).toBe(vm))
		const errors = () => self.log.mock.calls.filter(([level]) => level === 'error')
		expect(errors()).toHaveLength(2)

		// A failure after a successful connect is a new outage, so the same text is worth repeating.
		self.log.mockClear()
		open.mockRejectedValue(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))
		await connection.disconnect()
		await connection.connect()

		expect(errors()).toHaveLength(1)
	})
})

describe('describeConnectError', () => {
	function withCode(code: string): Error {
		return Object.assign(new Error(`connect ${code} 10.0.0.1:80`), { code })
	}

	it('names the device and the config field for a refused connection', () => {
		const failure = describeConnectError(withCode('ECONNREFUSED'), '10.0.0.1:80')

		expect(failure.status).toBe('Connection refused')
		expect(failure.detail).toContain('nothing is listening on 10.0.0.1:80')
		expect(failure.detail).toContain('Port')
	})

	it('distinguishes an unreachable network from an unresolvable address', () => {
		expect(describeConnectError(withCode('EHOSTUNREACH'), '10.0.0.1:80').status).toBe('Host unreachable')
		expect(describeConnectError(withCode('ENOTFOUND'), 'blade.local:80').status).toBe('Unknown host')
	})

	it('points at the login fields when the Blade is password protected', () => {
		const error = new Error(
			'Unable to connect to 10.0.0.1; this machine appears to be password-protected (try specifying the login parameter within your VM.open or VSocket.open call)',
		)

		const failure = describeConnectError(error, '10.0.0.1:80')

		expect(failure.status).toBe('Login required')
		expect(failure.detail).toContain('Username and Password')
	})

	it('suggests ws when the Blade presents its own certificate', () => {
		const failure = describeConnectError(withCode('DEPTH_ZERO_SELF_SIGNED_CERT'), '10.0.0.1:443')

		expect(failure.status).toBe('Certificate rejected')
		expect(failure.detail).toContain('set Protocol to ws')
	})

	it('reports vscript timeouts as no response', () => {
		const error = new Error('Timeout after 5000 ms (while trying to open WebSocket connection to 10.0.0.1)')

		expect(describeConnectError(error, '10.0.0.1:80').status).toBe('No response')
	})

	it('treats an HTTP answer that is not a Blade handshake as the wrong target', () => {
		const error = new Error('Connection attempt aborted; got unexpected response(status code: 404)')

		expect(describeConnectError(error, '10.0.0.1:80').status).toBe('Not a Blade')
	})

	it('handles the plain string a failed build_info download rejects with', () => {
		const failure = describeConnectError('Unable to download http://10.0.0.1:80/data/build_info.json', '10.0.0.1:80')

		expect(failure.status).toBe('Incomplete handshake')
	})

	it('calls an internal fault a module bug rather than a device problem', () => {
		const failure = describeConnectError(new TypeError('S is not a constructor'), '10.0.0.1:80')

		expect(failure.status).toBe('Module error')
		expect(failure.detail).toContain('bug in the module')
		expect(failure.detail).toContain('S is not a constructor')
	})

	it('falls back to the original message', () => {
		const failure = describeConnectError(new Error('something odd'), '10.0.0.1:80')

		expect(failure.status).toBe('Connection failed')
		expect(failure.detail).toContain('something odd')
	})
})
