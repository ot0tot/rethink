export type HoodLevels = {
    fan: number | undefined
    light: number | undefined
}

export type KitchenHoodPersistentState = {
    version: 1
    savedAt: number
    cooktopActive?: boolean
    fan: { owned: boolean; offDeadline?: number }
    light: { owned: boolean; offDeadline?: number }
}

export type KitchenHoodActions = {
    setFan: (level: number) => void
    setLight: (level: number) => void
    log?: (message: string) => void
    stateChanged?: (state: KitchenHoodPersistentState) => void
}

export type KitchenHoodOptions = {
    fanOffDelayMs?: number
    lightOffDelayMs?: number
    initialState?: KitchenHoodPersistentState
    now?: () => number
}

type Output = 'fan' | 'light'

type OwnedOutput = {
    owned: boolean
    target: number
    level: number | undefined
    waitingForState: boolean
    timer: ReturnType<typeof setTimeout> | undefined
    offDeadline: number | undefined
    generation: number
}

const DEFAULT_DELAY_MS = 5 * 60 * 1000

// Tracks which hood outputs it changed so manual settings are never undone.
export class KitchenHoodController {
    private cooktopActive: boolean | undefined
    private cooktopFresh = false
    private readonly outputs: Record<Output, OwnedOutput>
    private readonly now: () => number

    constructor(
        private readonly actions: KitchenHoodActions,
        private readonly options: KitchenHoodOptions = {},
    ) {
        const initial = options.initialState?.version === 1 ? options.initialState : undefined
        this.cooktopActive = initial?.cooktopActive
        this.now = options.now ?? Date.now
        this.outputs = {
            fan: {
                owned: initial?.fan.owned ?? false,
                target: 1,
                level: undefined,
                waitingForState: false,
                timer: undefined,
                offDeadline: initial?.fan.offDeadline,
                generation: 0,
            },
            light: {
                owned: initial?.light.owned ?? false,
                target: 2,
                level: undefined,
                waitingForState: false,
                timer: undefined,
                offDeadline: initial?.light.offDeadline,
                generation: 0,
            },
        }
    }

    updateHood(levels: HoodLevels) {
        this.updateOutput('fan', levels.fan)
        this.updateOutput('light', levels.light)
        this.persist()
    }

    markHoodUnknown() {
        for (const output of ['fan', 'light'] as const) {
            const state = this.outputs[output]
            state.level = undefined
            state.waitingForState = false
            this.pauseTimer(output)
        }
        this.persist()
    }

    updateCooktop(active: boolean) {
        const previous = this.cooktopActive
        const wasFresh = this.cooktopFresh
        this.cooktopActive = active
        this.cooktopFresh = true

        if (active) {
            if (!wasFresh || previous !== true) this.actions.log?.('cooktop active')
            for (const output of ['fan', 'light'] as const) {
                this.cancelTimer(output)
                if (this.outputs[output].owned) continue
                this.acquireOrWait(output)
            }
        } else {
            if (!wasFresh || previous !== false) this.actions.log?.('cooktop inactive')
            for (const output of ['fan', 'light'] as const) {
                this.outputs[output].waitingForState = false
                if (!this.outputs[output].owned) continue

                const resumePersistedDeadline = !wasFresh && previous === false
                if (!wasFresh || previous !== false) this.scheduleOff(output, resumePersistedDeadline)
                else this.resumeTimerIfReady(output)
            }
        }
        this.persist()
    }

    markCooktopUnknown() {
        this.cooktopFresh = false
        for (const output of ['fan', 'light'] as const) this.pauseTimer(output)
        this.persist()
    }

    stop() {
        for (const output of ['fan', 'light'] as const) this.pauseTimer(output)
        this.persist()
    }

    persistentState(): KitchenHoodPersistentState {
        return {
            version: 1,
            savedAt: this.now(),
            cooktopActive: this.cooktopActive,
            fan: { owned: this.outputs.fan.owned, offDeadline: this.outputs.fan.offDeadline },
            light: { owned: this.outputs.light.owned, offDeadline: this.outputs.light.offDeadline },
        }
    }

    snapshot() {
        return {
            cooktopActive: this.cooktopActive,
            fanOwned: this.outputs.fan.owned,
            lightOwned: this.outputs.light.owned,
            fanPendingOff: this.outputs.fan.timer !== undefined,
            lightPendingOff: this.outputs.light.timer !== undefined,
        }
    }

    private updateOutput(output: Output, level: number | undefined) {
        const state = this.outputs[output]
        state.level = level

        if (state.owned && level !== undefined && level !== state.target) {
            this.actions.log?.(`${output} manually changed; relinquishing automation ownership`)
            this.relinquish(output)
            return
        }

        if (this.cooktopFresh && this.cooktopActive && state.waitingForState && level !== undefined) {
            this.acquireOrWait(output)
        } else if (this.cooktopFresh && this.cooktopActive === false && state.owned) {
            this.resumeTimerIfReady(output)
        }
    }

    private acquireOrWait(output: Output) {
        const state = this.outputs[output]
        if (state.level === undefined) {
            state.waitingForState = true
            this.actions.log?.(`${output} state unknown; waiting for a fresh status`)
            return
        }

        state.waitingForState = false
        if (state.level !== 0) {
            this.actions.log?.(`${output} already on; preserving manual state`)
            return
        }

        state.owned = true
        state.offDeadline = undefined
        state.level = state.target
        this.actions.log?.(`turning ${output} on at automation level ${state.target}`)
        if (output === 'fan') this.actions.setFan(state.target)
        else this.actions.setLight(state.target)
    }

    private scheduleOff(output: Output, preserveDeadline = false) {
        const state = this.outputs[output]
        this.pauseTimer(output)
        const delay =
            output === 'fan'
                ? (this.options.fanOffDelayMs ?? DEFAULT_DELAY_MS)
                : (this.options.lightOffDelayMs ?? DEFAULT_DELAY_MS)
        if (!preserveDeadline || state.offDeadline === undefined) state.offDeadline = this.now() + delay
        this.resumeTimerIfReady(output)
    }

    private resumeTimerIfReady(output: Output) {
        const state = this.outputs[output]
        if (
            state.timer !== undefined ||
            !state.owned ||
            state.offDeadline === undefined ||
            !this.cooktopFresh ||
            this.cooktopActive !== false ||
            state.level !== state.target
        )
            return

        const remaining = Math.max(0, state.offDeadline - this.now())
        const generation = ++state.generation
        state.timer = setTimeout(() => this.finishDelay(output, generation), remaining)
        this.actions.log?.(`scheduled ${output} off in ${remaining / 1000} seconds`)
    }

    private finishDelay(output: Output, generation: number) {
        const state = this.outputs[output]
        state.timer = undefined
        if (state.generation !== generation || !this.cooktopFresh || this.cooktopActive !== false || !state.owned)
            return
        if (state.level !== state.target) {
            this.relinquish(output)
            this.persist()
            return
        }

        state.owned = false
        state.offDeadline = undefined
        state.level = 0
        this.actions.log?.(`turning automation-owned ${output} off`)
        if (output === 'fan') this.actions.setFan(0)
        else this.actions.setLight(0)
        this.persist()
    }

    private cancelTimer(output: Output) {
        this.pauseTimer(output)
        this.outputs[output].offDeadline = undefined
    }

    private pauseTimer(output: Output) {
        const state = this.outputs[output]
        state.generation++
        if (state.timer !== undefined) clearTimeout(state.timer)
        state.timer = undefined
    }

    private relinquish(output: Output) {
        this.cancelTimer(output)
        this.outputs[output].owned = false
        this.outputs[output].waitingForState = false
    }

    private persist() {
        this.actions.stateChanged?.(this.persistentState())
    }
}
