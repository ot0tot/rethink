import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WLSGL5833F'
import HABridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'

const DEVICE_ID = 'range-id'
const META: Metadata = { modelId: 'WLSGL5833F', modelName: 'WLSGL5833F', swVersion: '1.0' }

function aabb(inner: number[], extended = false) {
    const bytes = [0xaa, extended ? 0 : inner.length + 4, ...inner]
    const checksum = (bytes.reduce((sum, value) => sum + value, 0) & 0xff) ^ 0x55
    return Buffer.from([...bytes, checksum, 0xbb])
}

function record69(mode = 0, targetTemperature = 0) {
    const record = Array(69).fill(0)
    record[0] = 1
    record[1] = 3
    record[2] = 4
    record[3] = mode === 0 ? 0 : mode <= 4 ? 1 : 2
    record[4] = mode
    record[8] = targetTemperature >> 8
    record[9] = targetTemperature & 0xff
    return record
}

function status40cf(mode = 0, targetTemperature = 0) {
    const record = record69(mode, targetTemperature)
    return aabb([0x40, 0xcf, 0, record.length, ...record], true)
}

function status40b2(subtype: number, mode = 0, targetTemperature = 0) {
    const first = record69(mode, targetTemperature)
    const second = Array(69).fill(0)
    return aabb([0x40, 0xb2, subtype >> 8, subtype & 0xff, first.length, ...first, second.length, ...second], true)
}

function status40ec(configureCurrent: (record: number[]) => void) {
    const previous = Array(75).fill(0)
    const current = Array(75).fill(0)
    configureCurrent(current)
    return aabb([0x40, 0xec, ...previous, ...current])
}

function status40eb(configureCurrent: (record: number[]) => void) {
    const current = Array(75).fill(0)
    configureCurrent(current)
    return aabb([0x40, 0xeb, ...current])
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('WLSGL5833F', () => {
    test('publishes aggregate cooktop and decoded oven sensors', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        assert.deepEqual(Object.keys(components), [
            'cooktop',
            'oven_active',
            'oven_mode',
            'oven_target_temperature',
            'oven_door',
        ])
        assert.equal(components.cooktop.platform, 'binary_sensor')
        assert.equal(components.oven_active.platform, 'binary_sensor')
        assert.equal(components.oven_mode.platform, 'sensor')
        assert.equal(components.oven_target_temperature.unit_of_measurement, '°F')
        assert.equal(components.oven_door.device_class, 'door')
    })

    test('bridge recognizes model ID, padding, model name, and regional suffix', () => {
        const identities = [
            { modelId: 'WLSGL5833F', modelName: 'WLSGL5833F' },
            { modelId: 'WLSGL5833F  ', modelName: 'WLSGL5833F' },
            { modelId: 'unknown', modelName: 'WLSGL5833F' },
            { modelId: 'unknown', modelName: 'WLSGL5833F.ASTCNA0' },
        ]

        for (const identity of identities) {
            const ha = new MockHAConnection()
            const bridge = new HABridge(ha.asConnection())
            const thinq = new MockThinq2Device(DEVICE_ID, { ...META, ...identity })
            bridge.newDevice(thinq)
            assert.ok(bridge.haDevices.get(DEVICE_ID) instanceof DUT)
        }
    })

    test('decodes dedicated 40B1 and burner-specific 40B2 aggregate edges', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', aabb([0x40, 0xb1, 1, 1]))
        assert.equal(dev.cooktopActive, true)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop, 'ON')

        thinq.emit('data', aabb([0x40, 0xb1, 2, 0]))
        assert.equal(dev.cooktopActive, false)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop, 'OFF')

        thinq.emit('data', status40b2(0x0021))
        assert.equal(dev.cooktopActive, true)
        thinq.emit('data', status40b2(0x0022))
        assert.equal(dev.cooktopActive, false)
    })

    test('decodes authoritative oven mode and target temperature records', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', status40b2(0x0001, 0x01, 300))
        assert.equal(dev.ovenActive, true)
        assert.equal(dev.ovenMode, 'bake')
        assert.equal(dev.ovenTargetTemperature, 300)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_active, 'ON')

        thinq.emit('data', status40b2(0x0003, 0x10, 400))
        assert.equal(dev.ovenMode, 'air_fry')
        assert.equal(dev.ovenTargetTemperature, 400)

        thinq.emit('data', status40b2(0x0009))
        assert.equal(dev.ovenActive, false)
        assert.equal(dev.ovenMode, 'off')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_target_temperature, 0)
    })

    test('decodes all captured oven mode codes', () => {
        const { thinq, dev } = makeDevice()
        const modes = new Map([
            [0x01, 'bake'],
            [0x03, 'convection_bake'],
            [0x04, 'roast'],
            [0x07, 'broil'],
            [0x08, 'warm'],
            [0x09, 'proof'],
            [0x0b, 'slow_cook'],
            [0x10, 'air_fry'],
        ])
        for (const [code, name] of modes) {
            thinq.emit('data', status40cf(code, code <= 4 ? 350 : 0))
            assert.equal(dev.ovenMode, name)
        }
    })

    test('uses positive 40EC oven updates but ignores transient zero mode', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit(
            'data',
            status40ec((current) => {
                current[15] = 0x01
                current[21] = 0x01
                current[22] = 0x2c
            }),
        )
        assert.equal(dev.ovenMode, 'bake')
        assert.equal(dev.ovenTargetTemperature, 300)

        thinq.emit(
            'data',
            status40ec(() => {}),
        )
        assert.equal(dev.ovenActive, true)
        assert.equal(dev.ovenMode, 'bake')
    })

    test('decodes the 40EB snapshot as authoritative range state', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', status40eb(() => {}))

        assert.equal(dev.ovenActive, false)
        assert.equal(dev.ovenMode, 'off')
        assert.equal(dev.ovenDoorOpen, false)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_active, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.oven_door, 'OFF')
    })

    test('requests status on start', () => {
        const { thinq, dev } = makeDevice()
        dev.start()

        assert.equal(thinq.outbox[0].toString('hex'), 'aa1cf0ed114001000000180e111718191a1a1b0000000000000096bb')
    })

    test('decodes the oven door flag independently of other flags', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit(
            'data',
            status40ec((current) => (current[27] = 0x24)),
        )
        assert.equal(dev.ovenDoorOpen, true)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_door, 'ON')

        thinq.emit(
            'data',
            status40ec((current) => (current[27] = 0x20)),
        )
        assert.equal(dev.ovenDoorOpen, false)
        assert.equal(ha.devices[DEVICE_ID].properties.oven_door, 'OFF')
    })

    test('timer status cannot create a false cooktop event', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.emit('data', aabb([0x40, 0xb1, 2, 0]))
        thinq.emit(
            'data',
            status40ec((current) => (current[31] = 0x06)),
        )

        assert.equal(dev.cooktopActive, false)
        assert.equal(ha.devices[DEVICE_ID].properties.cooktop, 'OFF')
    })

    test('unknown nonzero mode remains active and visible', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', status40cf(0x55))
        assert.equal(dev.ovenActive, true)
        assert.equal(dev.ovenMode, 'unknown_0x55')
    })
})
