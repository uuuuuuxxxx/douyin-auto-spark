import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { Script } from 'node:vm'

const FIXED_NOW = Date.parse('2026-10-04T16:30:00.000Z')
const CURRENT_RUN_ID = 999

interface WorkflowRun {
  id: number
  event: string
  conclusion: string | null
  created_at: string
}

class FixedDate extends Date {
  constructor(value?: string | number) {
    super(value ?? FIXED_NOW)
  }

  static override now(): number {
    return FIXED_NOW
  }
}

function readDailyCheckScript(): string {
  const workflow = readFileSync(resolve(__dirname, '../.github/workflows/renew-fire.yml'), 'utf8')
  const lines = workflow.split(/\r?\n/)
  const stepIndex = lines.findIndex((line) => line.trim() === 'id: daily-check')
  assert.ok(stepIndex >= 0, 'daily-check step must exist')
  const relativeScriptIndex = lines
    .slice(stepIndex)
    .findIndex((line) => /^\s*script: \|\s*$/.test(line))
  assert.ok(relativeScriptIndex >= 0, 'daily-check must have an inline script block')
  const scriptIndex = stepIndex + relativeScriptIndex
  const indent = lines[scriptIndex].match(/^\s*/)?.[0].length ?? 0
  const scriptLines: string[] = []

  for (const line of lines.slice(scriptIndex + 1)) {
    if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) <= indent) {
      break
    }
    scriptLines.push(line.slice(indent + 2))
  }

  assert.ok(
    scriptLines.some((line) => line.trim()),
    'daily-check script must not be empty',
  )
  return scriptLines.join('\n')
}

const dailyCheckScript = new Script(`(async () => {\n${readDailyCheckScript()}\n})()`, {
  filename: 'renew-fire.yml:daily-check',
})

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 101,
    event: 'schedule',
    conclusion: 'failure',
    created_at: '2026-10-04T16:15:00.000Z',
    ...overrides,
  }
}

async function checkDailyRuns(runs: WorkflowRun[]): Promise<{
  should_run: string | undefined
  is_retry: string | undefined
}> {
  const outputs = new Map<string, string>()
  let requests = 0
  const result = dailyCheckScript.runInNewContext({
    Date: FixedDate,
    context: { repo: { owner: 'test-owner', repo: 'test-repo' }, runId: String(CURRENT_RUN_ID) },
    github: {
      rest: {
        actions: {
          listWorkflowRuns: async (query: Record<string, unknown>) => {
            requests += 1
            assert.equal(query.owner, 'test-owner')
            assert.equal(query.repo, 'test-repo')
            assert.equal(query.workflow_id, 'renew-fire.yml')
            return { data: { workflow_runs: runs } }
          },
        },
      },
    },
    core: {
      setOutput: (name: string, value: string): void => {
        outputs.set(name, value)
      },
      info: (_message: string): void => {},
    },
  }) as Promise<void>
  await result
  assert.equal(requests, 1)
  return { should_run: outputs.get('should_run'), is_retry: outputs.get('is_retry') }
}

test('a manual dry run success does not block scheduled sending or mark a retry', async () => {
  const output = await checkDailyRuns([
    workflowRun({ event: 'workflow_dispatch', conclusion: 'success' }),
  ])
  assert.deepEqual(output, { should_run: 'true', is_retry: 'false' })
})

test('a manual dry run success does not hide an earlier scheduled failure', async () => {
  const output = await checkDailyRuns([
    workflowRun(),
    workflowRun({ id: 102, event: 'workflow_dispatch', conclusion: 'success' }),
  ])
  assert.deepEqual(output, { should_run: 'true', is_retry: 'true' })
})

test('a manual failure does not mark the next scheduled run as a retry', async () => {
  const output = await checkDailyRuns([workflowRun({ event: 'workflow_dispatch' })])
  assert.deepEqual(output, { should_run: 'true', is_retry: 'false' })
})

for (const conclusion of ['failure', 'timed_out', 'cancelled']) {
  test(`a scheduled ${conclusion} enables a retry`, async () => {
    const output = await checkDailyRuns([workflowRun({ conclusion })])
    assert.deepEqual(output, { should_run: 'true', is_retry: 'true' })
  })
}

test('a successful scheduled run prevents another run today', async () => {
  const output = await checkDailyRuns([workflowRun({ conclusion: 'success' })])
  assert.deepEqual(output, { should_run: 'false', is_retry: 'false' })
})

test('a successful scheduled retry stops further retries despite earlier failures', async () => {
  const output = await checkDailyRuns([
    workflowRun(),
    workflowRun({ id: 102, conclusion: 'success' }),
  ])
  assert.deepEqual(output, { should_run: 'false', is_retry: 'false' })
})

test('yesterday in Beijing and the current run do not affect daily decisions', async () => {
  const output = await checkDailyRuns([
    workflowRun({ created_at: '2026-10-04T15:59:59.999Z', conclusion: 'success' }),
    workflowRun({ id: 102, created_at: '2026-10-04T15:59:59.999Z' }),
    workflowRun({ id: CURRENT_RUN_ID, conclusion: 'success' }),
    workflowRun({ id: CURRENT_RUN_ID }),
  ])
  assert.deepEqual(output, { should_run: 'true', is_retry: 'false' })
})

test('the Beijing day starts at midnight inclusive', async () => {
  const output = await checkDailyRuns([
    workflowRun({ created_at: '2026-10-04T16:00:00.000Z', conclusion: 'success' }),
  ])
  assert.deepEqual(output, { should_run: 'false', is_retry: 'false' })
})

test('the next Beijing midnight is outside today', async () => {
  const output = await checkDailyRuns([
    workflowRun({ created_at: '2026-10-05T16:00:00.000Z', conclusion: 'success' }),
  ])
  assert.deepEqual(output, { should_run: 'true', is_retry: 'false' })
})

test('a scheduled run with no conclusion does not mark a retry', async () => {
  const output = await checkDailyRuns([workflowRun({ conclusion: null })])
  assert.deepEqual(output, { should_run: 'true', is_retry: 'false' })
})
