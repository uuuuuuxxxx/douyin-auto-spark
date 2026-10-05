import { readFile } from 'node:fs/promises'

export type SparkMessageMode = 'default' | 'daily' | 'official-emoji'

export function resolveSparkMessageMode(value = process.env.SPARK_MESSAGE_MODE): SparkMessageMode {
  const mode = value?.trim().toLowerCase()

  if (!mode || mode === 'default') {
    return 'default'
  }

  if (mode === 'daily' || mode === 'official-emoji') {
    return mode
  }

  throw new Error('SPARK_MESSAGE_MODE 只能配置为 default、daily 或 official-emoji')
}

export function validateDailySparkMessages(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.some((message) => typeof message !== 'string' || !message.trim())
  ) {
    throw new Error('每日续火消息库必须包含至少两条非空字符串')
  }

  const messages = (value as string[]).map((message) => message.trim())

  if (new Set(messages).size !== messages.length) {
    throw new Error('每日续火消息库不能包含重复内容')
  }

  return messages
}

export async function readDailySparkMessages(
  filePath = 'assets/spark-messages.json',
): Promise<string[]> {
  const contents = await readFile(filePath, 'utf8')
  return validateDailySparkMessages(JSON.parse(contents) as unknown)
}

/** Select once per run: UTC+8 midnight changes the message, retries on the same date do not. */
export function selectDailySparkMessage(messages: readonly string[], now = new Date()): string {
  const validMessages = validateDailySparkMessages(messages)
  const timestamp = now.getTime()

  if (!Number.isFinite(timestamp)) {
    throw new Error('每日续火消息的日期无效')
  }

  const beijingDay = Math.floor((timestamp + 8 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000))
  const index = ((beijingDay % validMessages.length) + validMessages.length) % validMessages.length
  return validMessages[index]
}
