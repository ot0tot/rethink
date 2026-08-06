import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/WMVEL2137'
import HABridge from '@/cloud/ha_bridge'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, hex } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WMVEL2137'
const META: Metadata = { modelId: MODEL_ID, modelName: 'MVEL2033F', swVersion: '1.0' }

function status(combined: number) {
    const inner = Buffer.alloc(0x62 - 4, 0x80)
    inner[0] = 0x41
    inner[1] = 0xec
    inner[2 + 46 + 36] = combined
    return Buffer.concat([Buffer.from([0xaa, 0x62]), inner, Buffer.from([0x00, 0xbb])])
}

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe(MODEL_ID, () => {
    test('publishes native fan and light discovery config', () => {
        const { ha } = makeDevice()
        const components = ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>

        assert.equal(components.fan.platform, 'fan')
        assert.deepEqual(components.fan.preset_modes, ['low', 'medium', 'high', 'turbo'])
        assert.equal(components.light.platform, 'light')
        assert.equal(components.light.brightness_scale, 255)
    })

    test('bridge recognizes Wi-Fi ID, hardware model, padding, and regional suffixes', () => {
        const identities = [
            { modelId: 'WMVEL2137', modelName: 'MVEL2033F' },
            { modelId: 'MVEL2033F', modelName: 'MVEL2033F' },
            { modelId: 'WMVEL2137  ', modelName: 'MVEL2033F' },
            { modelId: '302', modelName: 'MVEL2033F.ASTCNA0' },
        ]

        for (const identity of identities) {
            const ha = new MockHAConnection()
            const bridge = new HABridge(ha.asConnection())
            const thinq = new MockThinq2Device(DEVICE_ID, { ...META, ...identity })

            bridge.newDevice(thinq)

            assert.ok(bridge.haDevices.get(DEVICE_ID) instanceof DUT)
        }
    })

    test('decodes stable fan and light levels from status byte 36', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', status(0x24))

        assert.equal(ha.devices[DEVICE_ID].properties.fan, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fan_preset, 'turbo')
        assert.equal(ha.devices[DEVICE_ID].properties.light, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.light_brightness, 255)
    })

    test('keeps the last stable light state during wraparound artifacts', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', status(0x22))
        thinq.emit('data', status(0x42))

        assert.equal(ha.devices[DEVICE_ID].properties.fan_preset, 'medium')
        assert.equal(ha.devices[DEVICE_ID].properties.light, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.light_brightness, 255)
    })

    test('fan TURBO from OFF emits the protocol command with a valid checksum', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', status(0x00))
        thinq.resetRecorder()

        dev.setProperty('fan_preset', 'turbo')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401040000808043BB')
    })

    test('light HIGH from OFF emits the protocol command with a valid checksum', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', status(0x00))
        thinq.resetRecorder()

        dev.setProperty('light_brightness', '255')

        assert.equal(thinq.outbox.length, 1)
        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220400000102808041BB')
    })

    test('fan OFF preserves the light', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', status(0x23))
        thinq.resetRecorder()

        dev.setProperty('fan', 'OFF')

        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220400000102808041BB')
    })

    test('fan LOW to MEDIUM sends the captured absolute target level', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', status(0x01))
        thinq.resetRecorder()

        dev.setProperty('fan_preset', 'medium')

        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220401020000808041BB')
    })

    test('light LOW to HIGH sends the captured absolute target level', () => {
        const { thinq, dev } = makeDevice()
        thinq.emit('data', status(0x10))
        thinq.resetRecorder()

        dev.setProperty('light_brightness', '255')

        assert.equal(hex(thinq.outbox[0]), 'AA0EF043220400000102808041BB')
    })

    test('unknown state needs only one idempotent target command', () => {
        const { ha, thinq, dev } = makeDevice()
        thinq.resetRecorder()

        dev.setProperty('fan_preset', 'medium')

        assert.deepEqual(thinq.outbox.map(hex), ['AA0EF0432204010200808080C1BB'])
        assert.equal(ha.devices[DEVICE_ID].properties.fan, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.fan_preset, 'medium')
    })

    test('generic device ACK preserves the optimistically published state', () => {
        const { ha, thinq, dev } = makeDevice()

        dev.setProperty('light_brightness', '255')
        thinq.emit('data', Buffer.from('AA084100430063BB', 'hex'))

        assert.equal(ha.devices[DEVICE_ID].properties.light, 'ON')
        assert.equal(ha.devices[DEVICE_ID].properties.light_brightness, 255)
    })

    test('captured sound-setting delta is not misread as fan/light state', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit(
            'data',
            Buffer.from(
                'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C30000000053A0000C00090001000000003000015500000000000000FF030D000000000000000000000000000000C30000000050A0000C00090001000000ADBB',
                'hex',
            ),
        )

        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })

    test('decodes the startup status snapshot', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit(
            'data',
            Buffer.from(
                'AA3441EB003000015500000000000000FF030D000000000000000000000000000000C3000000005300008080808001000000E3BB',
                'hex',
            ),
        )

        assert.equal(ha.devices[DEVICE_ID].properties.fan, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.light, 'OFF')
        assert.equal(ha.devices[DEVICE_ID].properties.light_brightness, 0)
    })

    test('requests status on start', () => {
        const { thinq, dev } = makeDevice()
        dev.start()

        assert.deepEqual(thinq.outbox.map(hex), ['AA1CF0ED114101000000180E111718191A1A1B0000000000000091BB'])
    })

    test('ignores packets that are not AA62 status reports', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', Buffer.from('AA085342000000BB', 'hex'))
        assert.deepEqual(ha.devices[DEVICE_ID].properties, {})
    })
})
