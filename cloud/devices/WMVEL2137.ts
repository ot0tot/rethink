import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const FAN_LEVELS = ['off', 'low', 'medium', 'high', 'turbo'] as const

type ControlField = readonly [command: number, advances: number]

const UNCHANGED: ControlField = [0x00, 0x80]
const OFF: ControlField = [0x00, 0x00]

function controlForLevel(level: number | undefined): ControlField {
    if (level === undefined) return UNCHANGED
    return level === 0 ? OFF : [0x01, level]
}

// Control levels are absolute button positions from OFF. Status byte 36 stores
// the light in its high nibble and fan in its low nibble.
export default class Device extends AABBDevice {
    private fanLevel: number | undefined
    private lightLevel: number | undefined
    private lastFanLevel = 1
    private lastLightLevel = 1

    get currentFanLevel() {
        return this.fanLevel
    }

    get currentLightLevel() {
        return this.lightLevel
    }

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Microwave' }),
                components: {
                    fan: {
                        platform: 'fan',
                        unique_id: '$deviceid-fan',
                        name: 'Hood fan',
                        icon: 'mdi:fan',
                        state_topic: '$this/fan',
                        command_topic: '$this/fan/set',
                        preset_mode_state_topic: '$this/fan_preset',
                        preset_mode_command_topic: '$this/fan_preset/set',
                        preset_modes: FAN_LEVELS.slice(1),
                    },
                    light: {
                        platform: 'light',
                        unique_id: '$deviceid-light',
                        name: 'Cooktop light',
                        icon: 'mdi:lightbulb',
                        state_topic: '$this/light',
                        command_topic: '$this/light/set',
                        brightness_state_topic: '$this/light_brightness',
                        brightness_command_topic: '$this/light_brightness/set',
                        brightness_scale: 255,
                        on_command_type: 'brightness',
                    },
                },
            }),
        )
    }

    private publishFanLevel(level: number) {
        this.fanLevel = level
        if (level > 0) this.lastFanLevel = level
        this.publishProperty('fan', level > 0 ? 'ON' : 'OFF')
        if (level > 0) this.publishProperty('fan_preset', FAN_LEVELS[level])
    }

    private publishLightLevel(level: number) {
        this.lightLevel = level
        if (level > 0) this.lastLightLevel = level
        this.publishProperty('light', level > 0 ? 'ON' : 'OFF')
        this.publishProperty('light_brightness', [0, 128, 255][level])
    }

    processAABB(buf: Buffer) {
        // 41EB is a snapshot; 41EC contains previous/current 46-byte records.
        let current: Buffer
        if (buf.length === 0x34 - 4 && buf[0] === 0x41 && buf[1] === 0xeb) current = buf.subarray(2)
        else if (buf.length === 0x62 - 4 && buf[0] === 0x41 && buf[1] === 0xec)
            current = buf.subarray(2 + 46, 2 + 46 * 2)
        else return

        const combined = current[36]
        const fan = combined & 0x0f
        const light = combined >> 4
        if (fan > 4 || light > 2) return

        this.publishFanLevel(fan)
        this.publishLightLevel(light)
    }

    private sendControl(fan: ControlField, light: ControlField) {
        this.send(Buffer.from([0xf0, 0x43, 0x22, 0x04, ...fan, ...light, 0x80, 0x80]))
    }

    start() {
        this.send(Buffer.from('F0ED114101000000180E111718191A1A1B00000000000000', 'hex'))
    }

    private setFanLevel(target: number) {
        // Repeat the known light level because this firmware can treat the
        // unchanged sentinel as OFF.
        this.sendControl(controlForLevel(target), controlForLevel(this.lightLevel))

        // WMVEL replies with a generic ACK that contains no resulting level.
        // Publish the expected state now; a later status report can correct it.
        this.publishFanLevel(target)
    }

    private setLightLevel(target: number) {
        this.sendControl(controlForLevel(this.fanLevel), controlForLevel(target))

        this.publishLightLevel(target)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fan') {
            if (mqttValue === 'OFF') this.setFanLevel(0)
            else if (mqttValue === 'ON') this.setFanLevel(this.fanLevel || this.lastFanLevel)
            return
        }

        if (prop === 'fan_preset') {
            const target = FAN_LEVELS.indexOf(mqttValue as (typeof FAN_LEVELS)[number])
            if (target > 0) this.setFanLevel(target)
            else console.warn(`Unexpected fan preset ${mqttValue}`)
            return
        }

        if (prop === 'light') {
            if (mqttValue === 'OFF') this.setLightLevel(0)
            else if (mqttValue === 'ON') this.setLightLevel(this.lightLevel || this.lastLightLevel)
            return
        }

        if (prop === 'light_brightness') {
            const brightness = Number(mqttValue)
            if (!Number.isFinite(brightness)) console.warn(`Unexpected light brightness ${mqttValue}`)
            else this.setLightLevel(brightness <= 0 ? 0 : brightness < 192 ? 1 : 2)
            return
        }

        console.warn(`Unknown property ${prop}`)
    }
}
