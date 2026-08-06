import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KitchenHoodController } from '@/util/kitchen-hood-controller'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

function setup(fanOffDelayMs = 300_000, lightOffDelayMs = 300_000) {
    const fanCommands: number[] = []
    const lightCommands: number[] = []
    const controller = new KitchenHoodController(
        {
            setFan: (level) => fanCommands.push(level),
            setLight: (level) => lightCommands.push(level),
        },
        { fanOffDelayMs, lightOffDelayMs },
    )
    return { controller, fanCommands, lightCommands }
}

test('turns off outputs on at the requested levels and owns only those outputs', () => {
    const { controller, fanCommands, lightCommands } = setup()
    controller.updateHood({ fan: 0, light: 0 })
    controller.updateCooktop(true)

    assert.deepEqual(fanCommands, [1])
    assert.deepEqual(lightCommands, [2])
    assert.deepEqual(controller.snapshot(), {
        cooktopActive: true,
        fanOwned: true,
        lightOwned: true,
        fanPendingOff: false,
        lightPendingOff: false,
    })
})

test('preserves outputs that were already on', () => {
    const { controller, fanCommands, lightCommands } = setup()
    controller.updateHood({ fan: 3, light: 1 })
    controller.updateCooktop(true)
    controller.updateCooktop(false)

    assert.deepEqual(fanCommands, [])
    assert.deepEqual(lightCommands, [])
    assert.equal(controller.snapshot().fanOwned, false)
    assert.equal(controller.snapshot().lightOwned, false)
})

test('tracks fan and light ownership independently', (t) => {
    enableMockTimers(t)
    const lightOnly = setup(500, 500)
    lightOnly.controller.updateHood({ fan: 3, light: 0 })
    lightOnly.controller.updateCooktop(true)
    lightOnly.controller.updateCooktop(false)

    const fanOnly = setup(500, 500)
    fanOnly.controller.updateHood({ fan: 0, light: 1 })
    fanOnly.controller.updateCooktop(true)
    fanOnly.controller.updateCooktop(false)
    tickMockTimers(t, 500)

    assert.deepEqual(lightOnly.fanCommands, [])
    assert.deepEqual(lightOnly.lightCommands, [2, 0])
    assert.deepEqual(fanOnly.fanCommands, [1, 0])
    assert.deepEqual(fanOnly.lightCommands, [])
})

test('turns automation-owned outputs off independently after their delays', (t) => {
    enableMockTimers(t)
    const { controller, fanCommands, lightCommands } = setup(500, 1_000)
    controller.updateHood({ fan: 0, light: 0 })
    controller.updateCooktop(true)
    controller.updateCooktop(false)

    tickMockTimers(t, 499)
    assert.deepEqual(fanCommands, [1])
    tickMockTimers(t, 1)
    assert.deepEqual(fanCommands, [1, 0])
    assert.deepEqual(lightCommands, [2])
    tickMockTimers(t, 500)
    assert.deepEqual(lightCommands, [2, 0])
})

test('relighting during cooldown cancels shutdown and retains ownership', (t) => {
    enableMockTimers(t)
    const { controller, fanCommands, lightCommands } = setup(1_000, 1_000)
    controller.updateHood({ fan: 0, light: 0 })
    controller.updateCooktop(true)
    controller.updateCooktop(false)
    tickMockTimers(t, 500)
    controller.updateCooktop(true)
    tickMockTimers(t, 1_000)

    assert.deepEqual(fanCommands, [1])
    assert.deepEqual(lightCommands, [2])
    assert.equal(controller.snapshot().fanOwned, true)
    assert.equal(controller.snapshot().lightOwned, true)
})

test('manual level changes relinquish ownership and cancel pending shutdown', (t) => {
    enableMockTimers(t)
    const { controller, fanCommands, lightCommands } = setup(500, 500)
    controller.updateHood({ fan: 0, light: 0 })
    controller.updateCooktop(true)
    controller.updateCooktop(false)

    controller.updateHood({ fan: 3, light: 1 })
    tickMockTimers(t, 500)

    assert.deepEqual(fanCommands, [1])
    assert.deepEqual(lightCommands, [2])
    assert.equal(controller.snapshot().fanOwned, false)
    assert.equal(controller.snapshot().lightOwned, false)
})

test('waits for fresh unknown hood states before deciding ownership', () => {
    const { controller, fanCommands, lightCommands } = setup()
    controller.updateCooktop(true)
    assert.deepEqual(fanCommands, [])
    assert.deepEqual(lightCommands, [])

    controller.updateHood({ fan: 0, light: 2 })
    assert.deepEqual(fanCommands, [1])
    assert.deepEqual(lightCommands, [])
    assert.equal(controller.snapshot().fanOwned, true)
    assert.equal(controller.snapshot().lightOwned, false)
})

test('duplicate cooktop reports do not restart or reverse the state machine', (t) => {
    enableMockTimers(t)
    const { controller, fanCommands } = setup(500, 500)
    controller.updateHood({ fan: 0, light: 1 })
    controller.updateCooktop(true)
    controller.updateCooktop(true)
    controller.updateCooktop(false)
    tickMockTimers(t, 250)
    controller.updateCooktop(false)
    tickMockTimers(t, 250)

    assert.deepEqual(fanCommands, [1, 0])
})

test('restores ownership and resumes the original deadline after fresh states arrive', (t) => {
    enableMockTimers(t)
    let now = 1_000
    const before = new KitchenHoodController(
        { setFan: () => {}, setLight: () => {} },
        { fanOffDelayMs: 500, lightOffDelayMs: 500, now: () => now },
    )
    before.updateHood({ fan: 0, light: 0 })
    before.updateCooktop(true)
    before.updateCooktop(false)
    const saved = before.persistentState()
    before.stop()

    assert.equal(saved.fan.offDeadline, 1_500)
    assert.equal(saved.light.offDeadline, 1_500)

    now = 1_200
    const fanCommands: number[] = []
    const lightCommands: number[] = []
    const restored = new KitchenHoodController(
        {
            setFan: (level) => fanCommands.push(level),
            setLight: (level) => lightCommands.push(level),
        },
        { initialState: saved, now: () => now },
    )

    restored.updateHood({ fan: 1, light: 2 })
    assert.equal(restored.snapshot().fanPendingOff, false)
    restored.updateCooktop(false)
    assert.equal(restored.snapshot().fanPendingOff, true)

    tickMockTimers(t, 299)
    assert.deepEqual(fanCommands, [])
    tickMockTimers(t, 1)
    assert.deepEqual(fanCommands, [0])
    assert.deepEqual(lightCommands, [0])
})

test('fresh active cooktop state cancels restored pending shutdowns', (t) => {
    enableMockTimers(t)
    const restored = new KitchenHoodController(
        {
            setFan: () => assert.fail('fan must not be changed'),
            setLight: () => assert.fail('light must not be changed'),
        },
        {
            initialState: {
                version: 1,
                savedAt: 900,
                cooktopActive: false,
                fan: { owned: true, offDeadline: 1_100 },
                light: { owned: true, offDeadline: 1_100 },
            },
            now: () => 1_000,
        },
    )

    restored.updateHood({ fan: 1, light: 2 })
    restored.updateCooktop(true)
    tickMockTimers(t, 1_000)

    assert.equal(restored.snapshot().fanOwned, true)
    assert.equal(restored.snapshot().fanPendingOff, false)
    assert.equal(restored.persistentState().fan.offDeadline, undefined)
})

test('manual state observed after restart relinquishes persisted ownership', () => {
    const restored = new KitchenHoodController(
        { setFan: () => {}, setLight: () => {} },
        {
            initialState: {
                version: 1,
                savedAt: 900,
                cooktopActive: false,
                fan: { owned: true, offDeadline: 1_100 },
                light: { owned: true, offDeadline: 1_100 },
            },
        },
    )

    restored.updateHood({ fan: 3, light: 1 })

    assert.equal(restored.snapshot().fanOwned, false)
    assert.equal(restored.snapshot().lightOwned, false)
})
