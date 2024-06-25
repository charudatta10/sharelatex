const { Subscription } = require('../../app/src/models/Subscription')
const RecurlyWrapper = require('../../app/src/Features/Subscription/RecurlyWrapper')
const SubscriptionUpdater = require('../../app/src/Features/Subscription/SubscriptionUpdater')
const minimist = require('minimist')
const { setTimeout } = require('node:timers/promises')

// make sure all `allMismatchReasons` are displayed in the output
const util = require('util')
const pLimit = require('p-limit')
util.inspect.defaultOptions.maxArrayLength = null

const ScriptLogger = {
  checkedSubscriptionsCount: 0,
  mismatchSubscriptionsCount: 0,
  allMismatchReasons: {},

  recordMismatch: (subscription, recurlySubscription) => {
    const mismatchReasons = {}
    if (subscription.planCode !== recurlySubscription.plan.plan_code) {
      mismatchReasons.recurlyPlan = recurlySubscription.plan.plan_code
      mismatchReasons.olPlan = subscription.planCode
    }
    if (recurlySubscription.state === 'expired') {
      mismatchReasons.state = 'expired'
    }

    if (!Object.keys(mismatchReasons).length) {
      return
    }

    ScriptLogger.mismatchSubscriptionsCount += 1
    const mismatchReasonsString = JSON.stringify(mismatchReasons)
    if (ScriptLogger.allMismatchReasons[mismatchReasonsString]) {
      ScriptLogger.allMismatchReasons[mismatchReasonsString].push({
        id: subscription._id,
        name: subscription.planCode,
      })
    } else {
      ScriptLogger.allMismatchReasons[mismatchReasonsString] = [
        {
          id: subscription._id,
          name: subscription.planCode,
        },
      ]
    }
  },

  printProgress: () => {
    console.warn(
      `Subscriptions checked: ${ScriptLogger.checkedSubscriptionsCount}. Mismatches: ${ScriptLogger.mismatchSubscriptionsCount}`
    )
  },

  printSummary: () => {
    console.log('All Mismatch Reasons:', ScriptLogger.allMismatchReasons)
    console.log(
      'Mismatch Subscriptions Count',
      ScriptLogger.mismatchSubscriptionsCount
    )
  },
}

const handleSyncSubscriptionError = async (subscription, error) => {
  console.warn(`Errors with subscription id=${subscription._id}:`, error)
  if (typeof error === 'string' && error.match(/429$/)) {
    await setTimeout(1000 * 60 * 5)
    return
  }
  if (typeof error === 'string' && error.match(/5\d\d$/)) {
    await setTimeout(1000 * 60)
    await syncSubscription(subscription)
    return
  }
  await setTimeout(80)
}

const syncSubscription = async subscription => {
  let recurlySubscription
  try {
    recurlySubscription = await RecurlyWrapper.promises.getSubscription(
      subscription.recurlySubscription_id
    )
  } catch (error) {
    await handleSyncSubscriptionError(subscription, error)
    return
  }

  ScriptLogger.recordMismatch(subscription, recurlySubscription)

  if (!COMMIT) {
    return
  }

  try {
    await SubscriptionUpdater.promises.updateSubscriptionFromRecurly(
      recurlySubscription,
      subscription,
      {}
    )
  } catch (error) {
    await handleSyncSubscriptionError(subscription, error)
    return
  }
  await setTimeout(80)
}

const syncSubscriptions = async subscriptions => {
  const limit = pLimit(ASYNC_LIMIT)
  return await Promise.all(
    subscriptions.map(subscription =>
      limit(() => syncSubscription(subscription))
    )
  )
}

const loopForSubscriptions = async skipInitial => {
  let skip = skipInitial

  // iterate while there are more subscriptions to fetch
  while (true) {
    const subscriptions = await Subscription.find({
      recurlySubscription_id: { $exists: true, $ne: '' },
    })
      .sort('_id')
      .skip(skip)
      .limit(FETCH_LIMIT)
      .exec()

    if (subscriptions.length === 0) {
      console.warn('DONE')
      return
    }

    await syncSubscriptions(subscriptions)

    ScriptLogger.checkedSubscriptionsCount += subscriptions.length
    retryCounter = 0
    ScriptLogger.printProgress()
    ScriptLogger.printSummary()

    skip += FETCH_LIMIT
  }
}

let retryCounter = 0
const run = async () => {
  while (true) {
    try {
      await loopForSubscriptions(
        MONGO_SKIP + ScriptLogger.checkedSubscriptionsCount
      )
      break
    } catch (error) {
      if (retryCounter < 3) {
        console.error(error)
        retryCounter += 1
        console.warn(`RETRYING IN 60 SECONDS. (${retryCounter}/3)`)
        await setTimeout(60000)
      } else {
        console.error('Failed after 3 retries')
        throw error
      }
    }
  }
}

let FETCH_LIMIT, ASYNC_LIMIT, COMMIT, MONGO_SKIP
const setup = () => {
  const argv = minimist(process.argv.slice(2))
  FETCH_LIMIT = argv.fetch ? argv.fetch : 100
  ASYNC_LIMIT = argv.async ? argv.async : 10
  MONGO_SKIP = argv.skip ? argv.skip : 0
  COMMIT = argv.commit !== undefined
  if (!COMMIT) {
    console.warn('Doing dry run without --commit')
  }
  if (MONGO_SKIP) {
    console.warn(`Skipping first ${MONGO_SKIP} records`)
  }
}

setup()
run().then(() => {
  process.exit()
})
