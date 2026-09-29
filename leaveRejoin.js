const { Movements, goals } = require('mineflayer-pathfinder')

const { GoalGetToBlock } = goals

function randomMs(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
}

function setupLeaveRejoin(bot, createBot) {
    // Timers
    let jumpTimer = null
    let jumpOffTimer = null
    let sleepCheckTimer = null

    // State
    let stopped = false
    let sleeping = false
    let sleepAttemptInProgress = false
    let lastLogAt = 0

    // Keep whatever pathfinder movements were already configured
    let previousMovements = null

    function logThrottled(msg, minGapMs = 2000) {
        const now = Date.now()

        if (now - lastLogAt >= minGapMs) {
            lastLogAt = now
            console.log(msg)
        }
    }

    function clearJumpTimers() {
        if (jumpTimer) clearTimeout(jumpTimer)
        if (jumpOffTimer) clearTimeout(jumpOffTimer)

        jumpTimer = null
        jumpOffTimer = null

        try {
            bot.setControlState('jump', false)
        } catch (e) {
            // Ignore if disconnected
        }
    }

    function clearSleepTimer() {
        if (sleepCheckTimer) {
            clearTimeout(sleepCheckTimer)
            sleepCheckTimer = null
        }
    }

    function cleanup() {
        stopped = true

        clearJumpTimers()
        clearSleepTimer()

        sleeping = false
        sleepAttemptInProgress = false
    }

    /*
     * Mineflayer's actual sleep-valid window:
     * 12541 -> 23458 ticks
     *
     * 0     = sunrise
     * 6000  = noon
     * 12000 = sunset
     * 18000 = midnight
     * 24000 = sunrise
     */
    function isNight() {
        if (!bot || !bot.time) return false

        const time = bot.time.timeOfDay

        return time >= 12541 && time <= 23458
    }

    function isBed(block) {
        if (!block) return false

        if (typeof bot.isABed === 'function') {
            return bot.isABed(block)
        }

        return (
            typeof block.name === 'string' &&
            block.name.endsWith('_bed')
        )
    }

    function getNearbyBeds() {
        if (!bot || !bot.entity || !bot.findBlocks) {
            return []
        }

        const positions = bot.findBlocks({
            matching: block => isBed(block),
            maxDistance: 32,
            count: 20
        })

        return positions
            .map(pos => bot.blockAt(pos))
            .filter(block => isBed(block))
            .sort((a, b) => {
                const da = bot.entity.position.distanceTo(a.position)
                const db = bot.entity.position.distanceTo(b.position)
                return da - db
            })
    }

    function isBedOccupied(bed) {
        try {
            if (typeof bot.parseBedMetadata === 'function') {
                const metadata = bot.parseBedMetadata(bed)
                return metadata?.occupied === true
            }
        } catch (e) {
            // Fall back to trying the bed
        }

        return false
    }

    async function pathToBed(bed) {
        if (!bot.pathfinder) {
            throw new Error('Pathfinder is not loaded')
        }

        /*
         * GoalGetToBlock puts the bot next to the bed instead of
         * trying to stand inside the bed block.
         */
        const goal = new GoalGetToBlock(
            bed.position.x,
            bed.position.y,
            bed.position.z
        )

        await bot.pathfinder.goto(goal)
    }

    async function trySleepAtBed(bed) {
        if (stopped || !bot.entity || !isNight()) {
            return false
        }

        if (isBedOccupied(bed)) {
            logThrottled(
                `[Sleep] Bed at ${bed.position.x}, ${bed.position.y}, ${bed.position.z} is occupied.`,
                3000
            )
            return false
        }

        logThrottled(
            `[Sleep] 🛏️ Going to bed at ${bed.position.x}, ${bed.position.y}, ${bed.position.z}...`,
            2000
        )

        // Stop random jumping.
        clearJumpTimers()

        // Remember current Pathfinder movements.
        previousMovements = bot.pathfinder.movements || null

        /*
         * Create a normal movement configuration so this module
         * still works even if another module hasn't configured
         * Pathfinder movements.
         */
        const sleepMovements = new Movements(bot)

        bot.pathfinder.setMovements(sleepMovements)
        bot.pathfinder.setGoal(null)

        try {
            // Walk beside the bed.
            await Promise.race([
                pathToBed(bed),
                new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error('timed out while walking to bed'))
                    }, 15000)
                })
            ])

            if (stopped || !bot.entity || !isNight()) {
                return false
            }

            // Stop all movement.
            bot.pathfinder.setGoal(null)

            try {
                bot.clearControlStates()
            } catch (e) {
                // Ignore
            }

            logThrottled('[Sleep] 🌙 At the bed. Attempting to sleep...', 2000)

            /*
             * Mineflayer's sleep() waits for the actual "sleep" event,
             * so this only returns successfully when the server puts
             * the bot into the bed.
             */
            await bot.sleep(bed)

            if (bot.isSleeping) {
                sleeping = true
                logThrottled('[Sleep] 😴 SUCCESS — bot is sleeping!', 1000)
                return true
            }

            return false
        } catch (err) {
            logThrottled(
                `[Sleep] ❌ Bed attempt failed: ${err?.message || err}`,
                2000
            )

            return false
        } finally {
            try {
                bot.pathfinder.setGoal(null)
            } catch (e) {
                // Ignore
            }

            // Restore the movement configuration used before sleeping.
            if (previousMovements) {
                try {
                    bot.pathfinder.setMovements(previousMovements)
                } catch (e) {
                    // Ignore
                }
            }

            previousMovements = null
        }
    }

    async function findBedAndSleep() {
        if (
            stopped ||
            sleeping ||
            sleepAttemptInProgress ||
            !bot.entity
        ) {
            return
        }

        if (!isNight()) {
            scheduleSleepCheck(5000)
            return
        }

        sleepAttemptInProgress = true

        try {
            const beds = getNearbyBeds()

            if (beds.length === 0) {
                logThrottled(
                    '[Sleep] 🌙 Night detected, but no bed is within 32 blocks.',
                    10000
                )

                scheduleSleepCheck(10000)
                return
            }

            logThrottled(
                `[Sleep] 🌙 Found ${beds.length} nearby bed(s).`,
                3000
            )

            for (const bed of beds) {
                if (
                    stopped ||
                    !bot.entity ||
                    !isNight() ||
                    bot.isSleeping
                ) {
                    break
                }

                const success = await trySleepAtBed(bed)

                if (success) {
                    sleeping = true
                    clearSleepTimer()
                    return
                }
            }

            // None of the beds worked.
            if (!bot.isSleeping && !stopped) {
                logThrottled(
                    '[Sleep] 😭 Could not use any nearby bed. Retrying...',
                    5000
                )

                scheduleSleepCheck(5000)
            }
        } finally {
            sleepAttemptInProgress = false
        }
    }

    function scheduleSleepCheck(delay = 5000) {
        if (stopped) return

        clearSleepTimer()

        sleepCheckTimer = setTimeout(() => {
            sleepCheckTimer = null

            if (stopped || !bot.entity) return

            // Already sleeping.
            if (sleeping || bot.isSleeping) {
                return
            }

            if (isNight()) {
                findBedAndSleep()
            } else {
                // Daytime: keep normal AFK jumping.
                if (!jumpTimer && !sleeping) {
                    scheduleNextJump()
                }

                scheduleSleepCheck(5000)
            }
        }, delay)
    }

    function scheduleNextJump() {
        if (
            stopped ||
            sleeping ||
            bot.isSleeping ||
            !bot.entity
        ) {
            return
        }

        // Never jump while it's nighttime.
        if (isNight()) {
            return
        }

        try {
            bot.setControlState('jump', true)

            jumpOffTimer = setTimeout(() => {
                if (!stopped) {
                    try {
                        bot.setControlState('jump', false)
                    } catch (e) {
                        // Ignore
                    }
                }

                jumpOffTimer = null
            }, 300)

            const nextJump = randomMs(
                20000,
                5 * 60 * 1000
            )

            jumpTimer = setTimeout(() => {
                jumpTimer = null
                scheduleNextJump()
            }, nextJump)
        } catch (e) {
            // Ignore if disconnected
        }
    }

    // =========================
    // SPAWN
    // =========================

    bot.once('spawn', () => {
        cleanup()
        stopped = false
        sleeping = false
        sleepAttemptInProgress = false

        console.log(
            `[Sleep] Module loaded. Minecraft time: ${bot.time?.timeOfDay ?? 'unknown'}`
        )

        if (isNight()) {
            console.log('[Sleep] 🌙 It is currently NIGHT.')
        } else {
            console.log('[Sleep] ☀️ It is currently DAY.')
        }

        // Normal daytime AFK.
        if (!isNight()) {
            scheduleNextJump()
        }

        // Start sleep monitoring.
        scheduleSleepCheck(3000)
    })

    // =========================
    // ACTUAL SLEEP EVENT
    // =========================

    bot.on('sleep', () => {
        sleeping = true
        sleepAttemptInProgress = false

        clearJumpTimers()
        clearSleepTimer()

        try {
            bot.pathfinder.setGoal(null)
            bot.clearControlStates()
        } catch (e) {
            // Ignore
        }

        console.log('[Sleep] 😴 BOT IS ACTUALLY IN BED!')
    })

    // =========================
    // ACTUAL WAKE EVENT
    // =========================

    bot.on('wake', () => {
        sleeping = false
        sleepAttemptInProgress = false

        console.log('[Sleep] ☀️ BOT WOKE UP! Resuming AFK.')

        if (!stopped && bot.entity) {
            scheduleNextJump()
            scheduleSleepCheck(3000)
        }
    })

    // =========================
    // CONNECTION EVENTS
    // =========================

    // No bot.quit() timer!
    // index.js handles reconnection.

    bot.on('end', () => {
        cleanup()
    })

    bot.on('kicked', () => {
        cleanup()
    })

    bot.on('error', () => {
        cleanup()
    })
}

module.exports = setupLeaveRejoin
