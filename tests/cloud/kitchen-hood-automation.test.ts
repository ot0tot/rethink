import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import KitchenHoodAutomation from '@/cloud/kitchen-hood-automation'
import HADevice from '@/cloud/devices/base'
import { MockHAConnection } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

type Command = [property: string, value: string]

class HoodDevice extends HADevice {
    readonly thinq = new EventEmitter()
    currentFanLevel: number | undefined = undefined
    currentLightLevel: number | undefined = undefined
    commands: Command[] = []

    constructor(id = 'hood') {
        super(new MockHAConnection().asConnection(), id)
    }

    setLevels(fan: number, light: number) {
        this.currentFanLevel = fan
        this.currentLightLevel = light
        this.thinq.emit('data')
    }

    override setProperty(property: string, value: string) {
        this.commands.push([property, value])
        if (property === 'fan') this.currentFanLevel = 0
        if (property === 'fan_preset') this.currentFanLevel = 1
        if (property === 'light') this.currentLightLevel = 0
        if (property === 'light_brightness') this.currentLightLevel = 2
        this.thinq.emit('data')
    }
}

class CooktopDevice extends HADevice {
    readonly thinq = new EventEmitter()
    cooktopActive: boolean | undefined = undefined
    cooktopRevision = 0

    constructor(id = 'cooktop') {
        super(new MockHAConnection().asConnection(), id)
    }

    setActive(active: boolean) {
        this.cooktopActive = active
        this.cooktopRevision++
        this.thinq.emit('data')
    }
}

function setup(delay = 300, stateFile?: string) {
    const automation = new KitchenHoodAutomation({
        fan_off_delay_seconds: delay,
        light_off_delay_seconds: delay,
        state_file: stateFile,
    })
    const hood = new HoodDevice()
    const cooktop = new CooktopDevice()
    automation.attach(hood)
    automation.attach(cooktop)
    return { automation, hood, cooktop }
}

test('binds compatible devices without configured IDs', (t) => {
    enableMockTimers(t)
    const { automation, hood, cooktop } = setup(1)
    hood.setLevels(0, 0)

    cooktop.setActive(true)
    assert.deepEqual(hood.commands, [
        ['fan_preset', 'low'],
        ['light_brightness', '255'],
    ])
    assert.equal(automation.controller.snapshot().fanOwned, true)
    assert.equal(automation.controller.snapshot().lightOwned, true)

    cooktop.setActive(false)
    tickMockTimers(t, 1_000)
    assert.deepEqual(hood.commands.slice(2), [
        ['fan', 'OFF'],
        ['light', 'OFF'],
    ])
})

test('preserves outputs that were already on', () => {
    const { hood, cooktop } = setup()
    hood.setLevels(3, 1)
    cooktop.setActive(true)
    cooktop.setActive(false)
    assert.deepEqual(hood.commands, [])
})

test('a manual level change relinquishes ownership', (t) => {
    enableMockTimers(t)
    const { automation, hood, cooktop } = setup(1)
    hood.setLevels(0, 0)
    cooktop.setActive(true)

    hood.setLevels(3, 1)
    cooktop.setActive(false)
    tickMockTimers(t, 1_000)

    assert.deepEqual(hood.commands, [
        ['fan_preset', 'low'],
        ['light_brightness', '255'],
    ])
    assert.equal(automation.controller.snapshot().fanOwned, false)
    assert.equal(automation.controller.snapshot().lightOwned, false)
})

test('configured IDs select devices when several are compatible', () => {
    const automation = new KitchenHoodAutomation({ microwave_id: 'selected', range_id: 'range' })
    const ignored = new HoodDevice('ignored')
    const selected = new HoodDevice('selected')
    const cooktop = new CooktopDevice('range')
    automation.attach(ignored)
    automation.attach(selected)
    automation.attach(cooktop)
    ignored.setLevels(0, 0)
    selected.setLevels(0, 0)
    cooktop.setActive(true)

    assert.deepEqual(ignored.commands, [])
    assert.equal(selected.commands.length, 2)
})

test('persists ownership and shutdown deadlines', (t) => {
    enableMockTimers(t)
    const directory = mkdtempSync(join(tmpdir(), 'rethink-hood-'))
    const stateFile = join(directory, 'state.json')
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const { hood, cooktop } = setup(60, stateFile)
    hood.setLevels(0, 0)
    cooktop.setActive(true)
    cooktop.setActive(false)

    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.version, 1)
    assert.equal(state.fan.owned, true)
    assert.equal(state.light.owned, true)
    assert.equal(typeof state.fan.offDeadline, 'number')
    assert.equal(typeof state.light.offDeadline, 'number')
})

test('restores a persisted deadline after fresh states arrive', (t) => {
    enableMockTimers(t)
    const directory = mkdtempSync(join(tmpdir(), 'rethink-hood-restore-'))
    const stateFile = join(directory, 'state.json')
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    writeFileSync(
        stateFile,
        JSON.stringify({
            version: 1,
            savedAt: Date.now(),
            cooktopActive: false,
            fan: { owned: true, offDeadline: Date.now() + 1_000 },
            light: { owned: true, offDeadline: Date.now() + 1_000 },
        }),
    )
    const { hood, cooktop } = setup(300, stateFile)
    hood.setLevels(1, 2)
    cooktop.setActive(false)
    tickMockTimers(t, 1_000)

    assert.deepEqual(hood.commands, [
        ['fan', 'OFF'],
        ['light', 'OFF'],
    ])
})
