const { goals } = require('mineflayer-pathfinder')

function randomMs(minMs, maxMs) {
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
}

function setupLeaveRejoin(bot, createBot) {
    // Timers
    let jumpTimer = null
    let jumpOffTimer = null
    let sleepCheckTimer = null
    let sleepRetryTimer = null

    // State
    let stopped = false
    let sleeping = false
    let sleepAttemptInProgress = false
    let lastLogAt = 0

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
            // Ignore if bot is already disconnected
        }
    }

    function clearSleepTimers() {
        if (sleepCheckTimer) clearTimeout(sleepCheckTimer)
        if (sleepRetryTimer) clearTimeout(sleepRetryTimer)

        sleepCheckTimer = null
        sleepRetryTimer = null
    }

    function cleanup() {
        stopped = true

        clearJumpTimers()
        clearSleepTimers()

        sleeping = false
        sleepAttemptInProgress = false
    }

    // Minecraft time:
    // 0     = sunrise
    // 6000  = noon
    // 12000 = sunset
    // 18000 = midnight
    // 24000 = next sunrise
    function isNight() {
        if (!bot || !bot.time) return false

        const time = bot.time.timeOfDay

        return time >= 12500 && time < 23500
    }

    function findNearestBed() {
        if (!bot || !bot.entity || !bot.findBlock) {
            return null
        }

        return bot.findBlock({
            matching: block => {
                return (
                    block &&
                    typeof block.name === 'string' &&
                    block.name.endsWith('_bed')
                )
            },
            maxDistance: 32
        })
    }

    function scheduleNextJump() {
        if (stopped || sleeping || !bot.entity) return

        // Don't keep jumping at night.
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
                        // Ignore disconnect errors
                    }
                }

                jumpOffTimer = null
            }, 300)

            // Random jump every 20s -> 5m
            const nextJump = randomMs(20000, 5 * 60 * 1000)

            jumpTimer = setTimeout(() => {
                jumpTimer = null
                scheduleNextJump()
            }, nextJump)
        } catch (e) {
            // Ignore control errors if disconnected
        }
    }

    async function goToBedAndSleep() {
        if (
            stopped ||
            sleeping ||
            sleepAttemptInProgress ||
            !bot ||
            !bot.entity ||
            !bot.pathfinder
        ) {
            return
        }

        if (!isNight()) {
            scheduleSleepCheck(5000)
            return
        }

        sleepAttemptInProgress = true

        try {
            const bed = findNearestBed()

            if (!bed) {
                logThrottled(
                    '[Sleep] 🌙 Night detected, but no bed was found within 32 blocks.',
                    10000
                )

                sleepAttemptInProgress = false
                scheduleSleepCheck(10000)
                return
            }

            logThrottled(
                `[Sleep] 🛏️ Bed found at ${bed.position.x}, ${bed.position.y}, ${bed.position.z}. Walking to it...`,
                3000
            )

            // Stop AFK jumping while going to the bed.
            clearJumpTimers()

            // Stop any previous pathfinder movement.
            try {
                bot.pathfinder.setGoal(null)
            } catch (e) {
                // Ignore
            }

            // Walk close to the bed.
            await bot.pathfinder.goto(
                new goals.GoalNear(
                    bed.position.x,
                    bed.position.y,
                    bed.position.z,
                    1
                )
            )

            if (stopped || !bot.entity) {
                sleepAttemptInProgress = false
                return
            }

            // It could have become daytime while walking.
            if (!isNight()) {
                sleepAttemptInProgress = false
                scheduleSleepCheck(5000)
                scheduleNextJump()
                return
            }

            // Stop movement before attempting to sleep.
            try {
                bot.pathfinder.setGoal(null)
                bot.clearControlStates()
            } catch (e) {
                // Ignore
            }

            logThrottled('[Sleep] 😴 Trying to sleep...')

            await bot.sleep(bed)

            // Mineflayer should emit "sleep" when this succeeds.
            sleeping = true
            sleepAttemptInProgress = false

            logThrottled('[Sleep] 💤 Bot is now sleeping.', 3000)

            // No more checks needed until wake.
            clearSleepTimers()
        } catch (err) {
            sleeping = false
            sleepAttemptInProgress = false

            try {
                bot.pathfinder.setGoal(null)
                bot.clearControlStates()
            } catch (e) {
                // Ignore
            }

            logThrottled(
                `[Sleep] Could not sleep: ${err?.message || err}`,
                5000
            )

            // Retry shortly in case the bed was occupied,
            // unreachable, or the timing was slightly off.
            scheduleSleepCheck(5000)
        }
    }

    function scheduleSleepCheck(delay = 5000) {
        if (stopped) return

        clearSleepTimers()

        sleepCheckTimer = setTimeout(() => {
            sleepCheckTimer = null

            if (stopped || !bot.entity) return

            if (sleeping || bot.isSleeping) {
                return
            }

            if (isNight()) {
                goToBedAndSleep()
            } else {
                // Daytime: make sure normal AFK jumping is running.
                if (!jumpTimer && !sleeping) {
                    scheduleNextJump()
                }

                scheduleSleepCheck(5000)
            }
        }, delay)
    }

    bot.once('spawn', () => {
        // Reset state for this connection.
        cleanup()
        stopped = false
        sleeping = false
        sleepAttemptInProgress = false

        logThrottled(
            '[AFK] ✅ Connected. Daytime AFK + automatic nighttime bed sleeping enabled.',
            3000
        )

        // Start normal daytime AFK movement.
        if (!isNight()) {
            scheduleNextJump()
        }

        // Start Minecraft-time sleep checking.
        scheduleSleepCheck(5000)
    })

    // Mineflayer emits this when the bot successfully enters a bed.
    bot.on('sleep', () => {
        sleeping = true
        sleepAttemptInProgress = false

        clearJumpTimers()
        clearSleepTimers()

        try {
            bot.pathfinder.setGoal(null)
            bot.clearControlStates()
        } catch (e) {
            // Ignore
        }

        logThrottled('[Sleep] 🛏️ Bot entered the bed and is sleeping.', 3000)
    })

    // Mineflayer emits this when morning wakes the bot.
    bot.on('wake', () => {
        sleeping = false
        sleepAttemptInProgress = false

        logThrottled('[Sleep] ☀️ Morning! Bot woke up and resumed AFK.', 3000)

        if (!stopped && bot.entity) {
            scheduleNextJump()
            scheduleSleepCheck(5000)
        }
    })

    // IMPORTANT:
    // No scheduled bot.quit() anymore.
    // Your index.js remains responsible for reconnecting if the connection ends.

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
