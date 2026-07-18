const FAN_LEVELS = ['OFF', 'LOW', 'MEDIUM', 'HIGH', 'TURBO']
const LIGHT_LEVELS = ['OFF', 'LOW', 'HIGH']

function hexByte(value) {
    return `0x${value.toString(16).padStart(2, '0').toUpperCase()}`
}

function parseHex(payload) {
    if (typeof payload !== 'string') return
    const compact = payload.replace(/\s+/g, '')
    if (!/^[0-9a-f]+$/i.test(compact) || compact.length % 2 !== 0) return

    const bytes = []
    for (let i = 0; i < compact.length; i += 2) bytes.push(Number.parseInt(compact.slice(i, i + 2), 16))
    return bytes
}

function checksumOk(bytes) {
    let sum = 0
    for (const value of bytes.slice(0, -2)) sum += value
    return (((sum & 0xff) ^ 0x55) & 0xff) === bytes[bytes.length - 2]
}

function settingState(value) {
    const sound = value & 0x03
    if (sound === 0) return 'sound OFF'
    if (sound === 3) return 'sound ON'
    return `sound bits ${hexByte(sound)}`
}

function controlState(command, value, levels) {
    if (command === 0 && value === 0x80) return 'unchanged'
    if (command === 0 && value === 0) return 'OFF'
    if (command === 1) return levels[value] ?? `target ${value}`
    return `command ${hexByte(command)}, value ${hexByte(value)}`
}

function decodeHoodCommand(body) {
    const fan = controlState(body[4], body[5], FAN_LEVELS)
    const light = controlState(body[6], body[7], LIGHT_LEVELS)
    return `Hood command — fan ${fan}; light ${light}`
}

function decodeClockSoundCommand(body) {
    const changes = []
    if (body[4] !== 0x80 && body[5] !== 0x80) {
        changes.push(`clock ${body[4].toString().padStart(2, '0')}:${body[5].toString().padStart(2, '0')}`)
    }
    if (body[7] === 0) changes.push('sound OFF')
    else if (body[7] === 3) changes.push('sound ON')
    else if (body[7] !== 0x80) changes.push(`sound value ${hexByte(body[7])}`)

    return `Settings command — ${changes.length ? changes.join('; ') : 'no decoded changes'}`
}

function decodeStatus(body) {
    const previous = body.slice(2, 2 + 46)
    const current = body.slice(2 + 46, 2 + 46 * 2)
    const changes = []

    for (let i = 0; i < current.length; i++) {
        if (previous[i] === current[i]) continue

        let description = `byte ${i}: ${hexByte(previous[i])} → ${hexByte(current[i])}`
        if (i === 35) description += ` (${settingState(previous[i])} → ${settingState(current[i])})`
        changes.push(description)
    }

    if (changes.length === 0) return 'Status update — no record changes'
    const visible = changes.slice(0, 8)
    const remainder = changes.length - visible.length
    return `Status update — ${visible.join('; ')}${remainder > 0 ? `; +${remainder} more` : ''}`
}

export function decodeMonitorPacket(payload) {
    const bytes = parseHex(payload)
    if (!bytes || bytes.length < 5 || bytes[0] !== 0xaa || bytes[bytes.length - 1] !== 0xbb) return

    const validLength = bytes[1] === bytes.length
    const validChecksum = checksumOk(bytes)
    const body = bytes.slice(2, -2)
    let summary

    if (body.length === 4 && body[0] === 0x41 && body[1] === 0 && body[2] === 0x43 && body[3] === 0) {
        summary = 'Device ACK'
    } else if (body.length >= 10 && body[0] === 0xf0 && body[1] === 0x43 && body[2] === 0x22 && body[3] === 0x04) {
        summary = decodeHoodCommand(body)
    } else if (body.length >= 18 && body[0] === 0xf0 && body[1] === 0x43 && body[2] === 0x21 && body[3] === 0x0e) {
        summary = decodeClockSoundCommand(body)
    } else if (body.length === 94 && body[0] === 0x41 && body[1] === 0xec) {
        summary = decodeStatus(body)
    } else if (body[0] === 0xf0 && body[1] === 0xef) {
        summary = `F0EF message — payload ${body
            .slice(2)
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')}`
    } else {
        summary = `AABB packet — body ${body
            .slice(0, 8)
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')}${body.length > 8 ? '…' : ''}`
    }

    const validation = [
        validLength ? 'length OK' : `length mismatch (${bytes[1]} ≠ ${bytes.length})`,
        validChecksum ? 'checksum OK' : 'checksum BAD',
    ]
    return { summary: `${summary} · ${validation.join(', ')}`, validLength, validChecksum }
}
