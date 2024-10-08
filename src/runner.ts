import {spawn, ChildProcess} from 'child_process'
import kill from 'tree-kill'
import {v4 as uuidv4} from 'uuid'
import * as core from '@actions/core'
import {setCheckRunOutput} from './output'
import * as os from 'os'
import fs from 'node:fs/promises'
import chalk from 'chalk'

const color = new chalk.Instance({level: 1})

// eslint-disable-next-line @typescript-eslint/naming-convention
export const DEFAULT_RESULT_FILE = 'autograde.json'

export type TestType = 'simple' | 'external'

export interface TestBase {
  readonly type?: TestType
  readonly name: string
  readonly setup?: string
  readonly run: string
  readonly timeout?: number
}

export type TestComparison = 'exact' | 'included' | 'regex'

export interface SimpleTest extends TestBase {
  readonly type?: 'simple' // Optional for backwards compatibility
  readonly points?: number
  readonly input?: string
  readonly output?: string
  readonly comparison?: TestComparison
}

export interface ExternalTest extends TestBase {
  readonly type: 'external'
  readonly resultFile?: string
  readonly keepResultFile?: boolean
}

export type Test = SimpleTest | ExternalTest

interface AutogradeResults {
  score?: number
  max_score?: number
  execution_time?: number
}

export class TestError extends Error {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, TestError)
  }
}

export class TestExitError extends Error {
  code?: number
  signal?: string

  constructor(message: string, code?: number, signal?: string) {
    super(message)
    this.code = code
    this.signal = signal
    Error.captureStackTrace(this, TestError)
  }
}

export class TestTimeoutError extends TestError {
  constructor(message: string) {
    super(message)
    Error.captureStackTrace(this, TestTimeoutError)
  }
}

export class TestOutputError extends TestError {
  expected: string
  actual: string

  constructor(message: string, expected: string, actual: string) {
    super(`${message}\nExpected:\n${expected}\nActual:\n${actual}`)
    this.expected = expected
    this.actual = actual

    Error.captureStackTrace(this, TestOutputError)
  }
}

const log = (text: string): void => {
  process.stdout.write(text + os.EOL)
}

const normalizeLineEndings = (text: string): string => {
  return text.replace(/\r\n/gi, '\n').trim()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const indent = (text: any): string => {
  let str = '' + new String(text)
  str = str.replace(/\r\n/gim, '\n').replace(/\n/gim, '\n  ')
  return str
}

const waitForExit = async (child: ChildProcess, timeout: number): Promise<void> => {
  // eslint-disable-next-line no-undef
  return new Promise((resolve, reject) => {
    let timedOut = false

    const exitTimeout = setTimeout(() => {
      timedOut = true
      reject(new TestTimeoutError(`Setup timed out in ${timeout} milliseconds`))
      if (typeof child.pid === 'number') kill(child.pid)
    }, timeout)

    child.once('exit', (code: number, signal: string) => {
      if (timedOut) return
      clearTimeout(exitTimeout)

      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new TestExitError(`Error: Exit with code: ${code} and signal: ${signal}`, code, signal))
      }
    })

    child.once('error', (error: Error) => {
      if (timedOut) return
      clearTimeout(exitTimeout)

      reject(error)
    })
  })
}

const runSetup = async (test: Test, cwd: string, timeout: number): Promise<void> => {
  if (!test.setup || test.setup === '') {
    return
  }

  const setup = spawn(test.setup, {
    cwd,
    shell: true,
    env: {
      PATH: process.env['PATH'],
      FORCE_COLOR: 'true',
    },
  })

  // Start with a single new line
  process.stdout.write(indent('\n'))

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup.stdout.on('data', (chunk) => {
    process.stdout.write(indent(chunk))
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup.stderr.on('data', (chunk) => {
    process.stderr.write(indent(chunk))
  })

  await waitForExit(setup, timeout)
}

const runCommand = async (test: Test, cwd: string, timeout: number): Promise<void> => {
  const child = spawn(test.run, {
    cwd,
    shell: true,
    env: {
      PATH: process.env['PATH'],
      FORCE_COLOR: 'true',
    },
  })

  let output = ''

  // Start with a single new line
  process.stdout.write(indent('\n'))

  // TODO We only really need to capture output for 'simple' test type
  child.stdout.on('data', (chunk) => {
    process.stdout.write(indent(chunk))
    output += chunk
  })

  child.stderr.on('data', (chunk) => {
    process.stderr.write(indent(chunk))
  })

  // Preload the inputs
  if ((test.type === undefined || test.type === 'simple') && test.input && test.input !== '') {
    child.stdin.write(test.input)
    child.stdin.end()
  }

  await waitForExit(child, timeout)

  //
  if (test.type && test.type !== 'simple') {
    return
  }

  // Eventually work off the the test type
  if ((!test.output || test.output == '') && (!test.input || test.input == '')) {
    return
  }

  const expected = normalizeLineEndings(test.output || '')
  const actual = normalizeLineEndings(output)

  switch (test.comparison) {
    case 'exact':
      if (actual != expected) {
        throw new TestOutputError(`The output for test ${test.name} did not match`, expected, actual)
      }
      break
    case 'regex':
      // Note: do not use expected here
      if (!actual.match(new RegExp(test.output || ''))) {
        throw new TestOutputError(`The output for test ${test.name} did not match`, test.output || '', actual)
      }
      break
    default:
      // The default comparison mode is 'included'
      if (!actual.includes(expected)) {
        throw new TestOutputError(`The output for test ${test.name} did not match`, expected, actual)
      }
      break
  }
}

export const run = async (test: Test, cwd: string): Promise<void> => {
  // Timeouts are in minutes, but need to be in ms
  let timeout = (test.timeout || 1) * 60 * 1000 || 30000
  const start = process.hrtime()
  await runSetup(test, cwd, timeout)
  const elapsed = process.hrtime(start)
  // Subtract the elapsed seconds (0) and nanoseconds (1) to find the remaining timeout
  timeout -= Math.floor(elapsed[0] * 1000 + elapsed[1] / 1000000)
  await runCommand(test, cwd, timeout)
}

export const runAll = async (tests: Array<Test>, cwd: string): Promise<void> => {
  let points = 0
  let availablePoints = 0
  let hasPoints = false

  // https://help.github.com/en/actions/reference/development-tools-for-github-actions#stop-and-start-log-commands-stop-commands
  const token = uuidv4()
  log('')
  log(`::stop-commands::${token}`)
  log('')

  let someFailed = false

  for (const test of tests) {
    const resultFile = test.type === 'external' ? test.resultFile || DEFAULT_RESULT_FILE : undefined
    if (resultFile) {
      // Output warning if result file already exists
      try {
        await fs.access(resultFile)
        core.warning(`Result file ${resultFile} already exists at start of test run`)
      } catch (error) {
        // All good, file should not exist
      }
    }

    try {
      log(color.cyan(`📝 ${test.name}`))
      log('')

      if ((test.type === undefined || test.type === 'simple') && test.points) {
        hasPoints = true
        availablePoints += test.points
      }
      await run(test, cwd)
      // No exception raised, test passed
      if ((test.type === undefined || test.type === 'simple') && test.points) {
        points += test.points
      }
      log('')
      log(color.green(`✅ ${test.name}`))
      log('')
    } catch (error) {
      someFailed = true
      log('')
      log(color.red(`❌ ${test.name}`))
      if (error instanceof Error) {
        core.setFailed(error.message)
      } else {
        core.setFailed(`Failed to run test '${test.name}'`)
      }
    }

    if (resultFile) {
      try {
        const autograde: AutogradeResults = JSON.parse(await fs.readFile(resultFile, {encoding: 'utf8'}))
        const score = autograde.score
        const maxScore = autograde.max_score
        if (score !== undefined && maxScore !== undefined) {
          hasPoints = true
          points += score
          availablePoints += maxScore
        }
        // Remove result file (unless otherwise specified)
        // XXX This code is too messy for type inference (even with "resultFile !== undefined" condition above)
        const extTest = test as ExternalTest
        if (extTest.keepResultFile === undefined) {
          core.warning('Please explicitly set "keepResultFile: false" in autograding.json')
        }
        if (extTest.keepResultFile === true && resultFile === DEFAULT_RESULT_FILE) {
          core.warning('Keeping result file with default filename; are you sure?')
        }
        if (extTest.keepResultFile !== true) {
          await fs.rm(resultFile, {force: true})
        }
      } catch (error) {
        if (error instanceof Error) {
          core.warning(`Error reading ${resultFile}: ${error.message}`)
        }
      }
    }
  }

  // Restart command processing
  log('')
  log(`::${token}::`)

  if (someFailed) {
    // We need a good failure experience
  } else {
    log('')
    log(color.green('All tests passed'))
    log('')
    log('✨🌟💖💎🦄💎💖🌟✨🌟💖💎🦄💎💖🌟✨')
    log('')
  }

  // Set the number of points
  if (hasPoints) {
    const text = `Points ${points}/${availablePoints}`
    log(color.bold.bgCyan.black(text))
    core.setOutput('Points', `${points}/${availablePoints}`)
    await setCheckRunOutput(text)
  }
}
