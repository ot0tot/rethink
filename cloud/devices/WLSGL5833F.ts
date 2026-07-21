import HADevice from './base'
import AABBDevice from './aabb_device'
import { allowExtendedType } from '@/util/casting'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { Device as Thinq2Device } from '../thinq2/device'

const OVEN_MODES: Record<number, string> = {
    0x00: 'off',
    0x01: 'bake',
    0x03: 'convection_bake',
    0x04: 'roast',
    0x07: 'broil',
    0x08: 'warm',
    0x09: 'proof',
    0x0b: 'slow_cook',
    0x10: 'air_fry',
}

// WLSGL5833F gas range.
//
// Captures from all five burners are identical: the appliance reports only
// aggregate cooktop activity, not the individual burner or flame level.
export default class Device extends AABBDevice {
    cooktopActive: boolean | undefined
    cooktopRevision = 0
    ovenActive: boolean | undefined
    ovenMode: string | undefined
    ovenTargetTemperature: number | undefined
    ovenDoorOpen: boolean | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Range' }),
                components: {
                    cooktop: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-cooktop',
                        name: 'Cooktop active',
                        icon: 'mdi:stove',
                        state_topic: '$this/cooktop',
                    },
                    oven_active: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-oven-active',
                        name: 'Oven active',
                        icon: 'mdi:toaster-oven',
                        state_topic: '$this/oven_active',
                    },
                    oven_mode: {
                        platform: 'sensor',
                        unique_id: '$deviceid-oven-mode',
                        name: 'Oven mode',
                        icon: 'mdi:toaster-oven',
                        state_topic: '$this/oven_mode',
                    },
                    oven_target_temperature: {
                        platform: 'sensor',
                        unique_id: '$deviceid-oven-target-temperature',
                        name: 'Oven target temperature',
                        device_class: 'temperature',
                        unit_of_measurement: '°F',
                        state_class: 'measurement',
                        state_topic: '$this/oven_target_temperature',
                    },
                    oven_door: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-oven-door',
                        name: 'Oven door',
                        device_class: 'door',
                        state_topic: '$this/oven_door',
                    },
                },
            }),
        )
    }

    private publishCooktop(active: boolean) {
        if (this.cooktopActive === active) return
        this.cooktopActive = active
        this.cooktopRevision++
        this.publishProperty('cooktop', active ? 'ON' : 'OFF')
    }

    private publishOven(modeCode: number, targetTemperature: number) {
        this.ovenActive = modeCode !== 0
        this.ovenMode = OVEN_MODES[modeCode] ?? `unknown_0x${modeCode.toString(16).padStart(2, '0')}`
        this.ovenTargetTemperature = targetTemperature
        this.publishProperty('oven_active', this.ovenActive ? 'ON' : 'OFF')
        this.publishProperty('oven_mode', this.ovenMode)
        this.publishProperty('oven_target_temperature', targetTemperature)
    }

    private processStatusRecord(record: Buffer) {
        if (record.length !== 69) return
        this.publishOven(record[4], record.readUInt16BE(8))
    }

    private processSettingsRecord(record: Buffer, authoritative: boolean) {
        if (record.length !== 75) return
        this.ovenDoorOpen = (record[27] & 0x04) !== 0
        this.publishProperty('oven_door', this.ovenDoorOpen ? 'ON' : 'OFF')
        if (authoritative || record[15] !== 0) this.publishOven(record[15], record.readUInt16BE(21))
    }

    processAABB(buf: Buffer) {
        // Immediate aggregate edge: 40B1 0101=active, 40B1 0200=inactive.
        if (buf.length === 4 && buf[0] === 0x40 && buf[1] === 0xb1) {
            if (buf[2] === 1 && buf[3] === 1) this.publishCooktop(true)
            else if (buf[2] === 2 && buf[3] === 0) this.publishCooktop(false)
            return
        }

        // 40EB is the 75-byte snapshot returned by the status query.
        if (buf.length === 2 + 75 && buf[0] === 0x40 && buf[1] === 0xeb) {
            this.processSettingsRecord(buf.subarray(2), true)
            return
        }

        // 40EC carries 75-byte previous/current records. Positive mode records
        // provide prompt oven updates, but a transient all-zero record also
        // occurs during temperature changes and must not be treated as OFF.
        // Door state is bit 0x04 of the flags at offset 27.
        if (buf.length === 2 + 75 * 2 && buf[0] === 0x40 && buf[1] === 0xec) {
            this.processSettingsRecord(buf.subarray(2 + 75), false)
            return
        }

        // 40CF carries one length-prefixed 69-byte status record.
        if (buf.length >= 4 + 69 && buf[0] === 0x40 && buf[1] === 0xcf && buf[3] === 69) {
            this.processStatusRecord(buf.subarray(4, 4 + 69))
            return
        }

        // 40B2 subtypes 0x0021/0x0022 are the burner-specific aggregate edges.
        // Other subtypes carry authoritative oven start/stop status records.
        if (buf.length >= 5 + 69 && buf[0] === 0x40 && buf[1] === 0xb2 && buf[4] === 69) {
            const subtype = buf.readUInt16BE(2)
            if (subtype === 0x0021) this.publishCooktop(true)
            else if (subtype === 0x0022) this.publishCooktop(false)
            this.processStatusRecord(buf.subarray(5, 5 + 69))
        }
    }

    start() {
        this.send(Buffer.from('F0ED114001000000180E111718191A1A1B00000000000000', 'hex'))
    }
}
