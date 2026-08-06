import HADevice from './devices/base'
import { KitchenHoodController, type KitchenHoodPersistentState } from '@/util/kitchen-hood-controller'
import { type KitchenHoodConfig } from '@/util/config'
import log from '@/util/logging'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type EventEmitter } from 'node:events'

type DataDevice = HADevice & { thinq: EventEmitter }
type HoodDevice = DataDevice & {
    currentFanLevel: number | undefined
    currentLightLevel: number | undefined
}
type CooktopDevice = DataDevice & {
    cooktopActive: boolean | undefined
    cooktopRevision: number
}

type Binding = {
    device: DataDevice
    listener: () => void
}

function isHoodDevice(device: HADevice): device is HoodDevice {
    return 'thinq' in device && 'currentFanLevel' in device && 'currentLightLevel' in device
}

function isCooktopDevice(device: HADevice): device is CooktopDevice {
    return 'thinq' in device && 'cooktopRevision' in device
}

export default class KitchenHoodAutomation {
    private microwave: HoodDevice | undefined
    private range: CooktopDevice | undefined
    private microwaveBinding: Binding | undefined
    private rangeBinding: Binding | undefined
    private lastCooktopRevision = 0
    readonly controller: KitchenHoodController

    constructor(private readonly config: KitchenHoodConfig) {
        const initialState = this.loadState()
        this.controller = new KitchenHoodController(
            {
                setFan: (level) =>
                    this.microwave?.setProperty(level === 0 ? 'fan' : 'fan_preset', level === 0 ? 'OFF' : 'low'),
                setLight: (level) =>
                    this.microwave?.setProperty(
                        level === 0 ? 'light' : 'light_brightness',
                        level === 0 ? 'OFF' : '255',
                    ),
                log: (message) => log('status', `kitchen hood: ${message}`),
                stateChanged: (state) => this.saveState(state),
            },
            {
                fanOffDelayMs: (config.fan_off_delay_seconds ?? 300) * 1000,
                lightOffDelayMs: (config.light_off_delay_seconds ?? 300) * 1000,
                initialState,
            },
        )
    }

    attach(device: HADevice) {
        if (device === this.microwave || device === this.range) return
        if (isHoodDevice(device) && this.matchesConfiguredId(device.id, this.config.microwave_id)) {
            if (!this.microwave || this.microwave.id === device.id) this.attachMicrowave(device)
            else
                log(
                    'status',
                    `kitchen hood: ignoring additional microwave ${device.id}; using discovered ${this.microwave.id}`,
                )
        }
        if (isCooktopDevice(device) && this.matchesConfiguredId(device.id, this.config.range_id)) {
            if (!this.range || this.range.id === device.id) this.attachRange(device)
            else
                log('status', `kitchen hood: ignoring additional range ${device.id}; using discovered ${this.range.id}`)
        }
    }

    detach(device: HADevice) {
        if (this.microwaveBinding?.device === device) {
            this.removeBinding(this.microwaveBinding)
            this.microwaveBinding = undefined
            this.microwave = undefined
            this.controller.markHoodUnknown()
        }
        if (this.rangeBinding?.device === device) {
            this.removeBinding(this.rangeBinding)
            this.rangeBinding = undefined
            this.range = undefined
            this.controller.markCooktopUnknown()
        }
    }

    refresh(device: HADevice) {
        if (device === this.microwave) this.refreshMicrowave()
        if (device === this.range) this.refreshRange()
    }

    stop() {
        if (this.microwaveBinding) this.removeBinding(this.microwaveBinding)
        if (this.rangeBinding) this.removeBinding(this.rangeBinding)
        this.microwaveBinding = undefined
        this.rangeBinding = undefined
        this.controller.stop()
    }

    private attachMicrowave(device: HoodDevice) {
        if (this.microwaveBinding) this.removeBinding(this.microwaveBinding)
        this.microwave = device
        const listener = () => this.refreshMicrowave()
        device.thinq.on('data', listener)
        this.microwaveBinding = { device, listener }
        log('status', `kitchen hood: ${this.config.microwave_id ? 'configured' : 'discovered'} microwave ${device.id}`)
        this.refreshMicrowave()
    }

    private attachRange(device: CooktopDevice) {
        if (this.rangeBinding) this.removeBinding(this.rangeBinding)
        this.range = device
        this.lastCooktopRevision = device.cooktopRevision
        const listener = () => this.refreshRange()
        device.thinq.on('data', listener)
        this.rangeBinding = { device, listener }
        log('status', `kitchen hood: ${this.config.range_id ? 'configured' : 'discovered'} range ${device.id}`)
    }

    private refreshMicrowave() {
        if (!this.microwave) return
        this.controller.updateHood({
            fan: this.microwave.currentFanLevel,
            light: this.microwave.currentLightLevel,
        })
    }

    private refreshRange() {
        if (!this.range || this.range.cooktopRevision === this.lastCooktopRevision) return
        this.lastCooktopRevision = this.range.cooktopRevision
        if (this.range.cooktopActive !== undefined) this.controller.updateCooktop(this.range.cooktopActive)
    }

    private removeBinding(binding: Binding) {
        binding.device.thinq.off('data', binding.listener)
    }

    private matchesConfiguredId(deviceId: string, configuredId: string | undefined) {
        return !configuredId || configuredId === deviceId
    }

    private loadState(): KitchenHoodPersistentState | undefined {
        if (!this.config.state_file) return
        try {
            const state = JSON.parse(readFileSync(this.config.state_file, 'utf8')) as KitchenHoodPersistentState
            if (
                state.version === 1 &&
                typeof state.savedAt === 'number' &&
                Number.isFinite(state.savedAt) &&
                (state.cooktopActive === undefined || typeof state.cooktopActive === 'boolean') &&
                typeof state.fan?.owned === 'boolean' &&
                (state.fan.offDeadline === undefined ||
                    (typeof state.fan.offDeadline === 'number' && Number.isFinite(state.fan.offDeadline))) &&
                typeof state.light?.owned === 'boolean' &&
                (state.light.offDeadline === undefined ||
                    (typeof state.light.offDeadline === 'number' && Number.isFinite(state.light.offDeadline)))
            ) {
                log('status', `kitchen hood: restored ownership state from ${this.config.state_file}`)
                return state
            }
            console.warn(`Ignoring invalid kitchen hood state in ${this.config.state_file}`)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                console.warn(`Unable to load kitchen hood state ${this.config.state_file}: ${error}`)
        }
    }

    private saveState(state: KitchenHoodPersistentState) {
        if (!this.config.state_file) return
        try {
            mkdirSync(dirname(this.config.state_file), { recursive: true })
            const temporary = `${this.config.state_file}.${process.pid}.tmp`
            writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
            renameSync(temporary, this.config.state_file)
        } catch (error) {
            console.warn(`Unable to save kitchen hood state ${this.config.state_file}: ${error}`)
        }
    }
}
