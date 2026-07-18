import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeMonitorPacket } from '@/html/packet-decoder.js'

const cases = [
    ['aa0ef0432204008001018080c6bb', 'Hood command — fan unchanged; light LOW'],
    ['aa0ef0432204008001028080c1bb', 'Hood command — fan unchanged; light HIGH'],
    ['aa0ef0432204010100808080c6bb', 'Hood command — fan LOW; light unchanged'],
    ['aa0ef0432204010200808080c1bb', 'Hood command — fan MEDIUM; light unchanged'],
] as const

for (const [packet, expected] of cases) {
    test(`decodes captured command ${packet}`, () => {
        const decoded = decodeMonitorPacket(packet)
        assert.ok(decoded)
        assert.match(decoded.summary, new RegExp(expected))
        assert.equal(decoded.validLength, true)
        assert.equal(decoded.validChecksum, true)
    })
}

test('decodes the generic device ACK', () => {
    assert.match(decodeMonitorPacket('AA084100430063BB')!.summary, /Device ACK/)
})

test('decodes captured sound OFF and ON commands', () => {
    assert.match(decodeMonitorPacket('aa16f043210e8080800080808080800000000080f7bb')!.summary, /sound OFF/)
    assert.match(decodeMonitorPacket('aa16f043210e8080800380808080800000000080f0bb')!.summary, /sound ON/)
})

test('decodes a clock command', () => {
    const decoded = decodeMonitorPacket('aa16f043210e17320080008080801300000000002bbb')
    assert.ok(decoded)
    assert.match(decoded.summary, /clock 23:50/)
    assert.equal(decoded.validChecksum, true)
})

test('decodes a captured AA62 sound-setting status delta', () => {
    const packet =
        'AA6241EC003000015500000000000000FF030D000000000000000000000000000000C30000000053A0000C00090001000000003000015500000000000000FF030D000000000000000000000000000000C30000000050A0000C00090001000000ADBB'
    const decoded = decodeMonitorPacket(packet)
    assert.ok(decoded)
    assert.match(decoded.summary, /byte 35: 0x53 → 0x50/)
    assert.match(decoded.summary, /sound ON → sound OFF/)
    assert.equal(decoded.validChecksum, true)
})

test('reports a bad checksum without rejecting the packet', () => {
    const decoded = decodeMonitorPacket('aa084100430000bb')
    assert.ok(decoded)
    assert.equal(decoded.validChecksum, false)
    assert.match(decoded.summary, /checksum BAD/)
})
