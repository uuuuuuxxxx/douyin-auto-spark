import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  readDailySparkMessages,
  resolveSparkMessageMode,
  selectDailySparkMessage,
  validateDailySparkMessages,
} from '../src/daily-message'

const fixture = ['续火第一条', '续火第二条', '续火第三条']

test('daily messages switch at Beijing midnight rather than UTC midnight', () => {
  const beforeMidnight = selectDailySparkMessage(fixture, new Date('2026-10-05T15:59:59.999Z'))
  const afterMidnight = selectDailySparkMessage(fixture, new Date('2026-10-05T16:00:00.000Z'))
  assert.notEqual(beforeMidnight, afterMidnight)
  assert.equal(
    afterMidnight,
    selectDailySparkMessage(fixture, new Date('2026-10-06T00:00:00.000Z')),
  )
})

test('reruns on the same Beijing date keep the same message', () => {
  assert.equal(
    selectDailySparkMessage(fixture, new Date('2026-10-05T16:01:00Z')),
    selectDailySparkMessage(fixture, new Date('2026-10-06T15:59:00Z')),
  )
})

test('consecutive dates differ, including the end of a message cycle', () => {
  const start = Date.parse('2026-10-05T17:00:00Z')
  const messages = Array.from({ length: 7 }, (_, day) =>
    selectDailySparkMessage(fixture, new Date(start + day * 24 * 60 * 60 * 1000)),
  )
  for (let index = 1; index < messages.length; index += 1) {
    assert.notEqual(messages[index - 1], messages[index])
  }
  assert.equal(messages[0], messages[3])
})

test('message mode keeps the original behavior unless daily is explicitly enabled', () => {
  assert.equal(resolveSparkMessageMode(''), 'default')
  assert.equal(resolveSparkMessageMode('default'), 'default')
  assert.equal(resolveSparkMessageMode(' DAILY '), 'daily')
  assert.throws(() => resolveSparkMessageMode('random'), /SPARK_MESSAGE_MODE/)
})

test('invalid or repeated library entries cannot produce empty or repeated daily messages', () => {
  for (const invalid of [
    null,
    [],
    ['只有一条'],
    ['', '第二条'],
    ['第一条', 42],
    ['同一条', ' 同一条 '],
  ]) {
    assert.throws(() => validateDailySparkMessages(invalid), /每日续火消息库/)
  }
  assert.throws(() => selectDailySparkMessage(fixture, new Date('invalid')), /日期无效/)
})

test('the shipped library has 30 distinct messages and all cycle transitions differ', async () => {
  const messages = await readDailySparkMessages()
  assert.equal(messages.length, 30)
  const start = Date.parse('2026-10-05T17:00:00Z')
  let previous = selectDailySparkMessage(messages, new Date(start))
  for (let day = 1; day <= messages.length; day += 1) {
    const current = selectDailySparkMessage(messages, new Date(start + day * 24 * 60 * 60 * 1000))
    assert.notEqual(current, previous)
    previous = current
  }
})
