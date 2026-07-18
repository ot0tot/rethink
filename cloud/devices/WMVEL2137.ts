import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

const FAN_LEVELS = ['off', 'low', 'medium', 'high', 'turbo'] as const
const LIGHT_LEVELS = ['off', 'low', 'high'] as const

type ControlField = readonly [command: number, advances: number]

const UNCHANGED: ControlField = [0x00, 0x80]
const OFF: ControlField = [0x00, 0x00]

// WMVEL2137 (LG MVEL2033F microwave/hood combo)
//
// Command 0x01 names the target level using its button-count from OFF: 1=LOW,
// 2=MED/HIGH, 3=HIGH, 4=TURBO. Live LOW->MED and LOW->HIGH captures still send
// 2, so this field is idempotent rather than relative to the current level.
// A direct OFF command is also available.
// Status packets identify the combined fan/light state with tag 0x53; the upper
// nibble is fan (0..4) and the lower nibble is light (0..2 when stable).
export default class Device extends AABBDevice {
    private fanLevel: number | undefined
    private lightLevel: number | undefined
    private lastFanLevel = 1
    private lastLightLevel = 1

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
        // AA62 41EC contains 46-byte previous and current status records. Only
        // inspect the current record; the previous record would publish stale state.
        if (buf.length !== 0x62 - 4 || buf[0] !== 0x41 || buf[1] !== 0xec) return
        const current = buf.subarray(2 + 46, 2 + 46 * 2)

        for (let i = 0; i < current.length - 1; i++) {
            if (current[i] !== 0x53) continue

            const combined = current[i + 1]
            const fan = combined >> 4
            const light = combined & 0x0f
            if (fan > 4) continue

            this.publishFanLevel(fan)

            // Values 3+ occur briefly while the light wraps HIGH -> OFF. Keep
            // the last stable value until the appliance reports 0, 1, or 2.
            if (light <= 2) {
                this.publishLightLevel(light)
            }
            return
        }
    }

    private sendControl(fan: ControlField, light: ControlField) {
        this.send(Buffer.from([0xf0, 0x43, 0x22, 0x04, ...fan, ...light, 0x80, 0x80]))
    }

    private setFanLevel(target: number) {
        if (target === 0) {
            this.sendControl(OFF, UNCHANGED)
        } else {
            this.sendControl([0x01, target], UNCHANGED)
        }

        // WMVEL replies with a generic ACK that contains no resulting level.
        // Publish the expected state now; a later status report can correct it.
        this.publishFanLevel(target)
    }

    private setLightLevel(target: number) {
        if (target === 0) {
            this.sendControl(UNCHANGED, OFF)
        } else {
            this.sendControl(UNCHANGED, [0x01, target])
        }

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
