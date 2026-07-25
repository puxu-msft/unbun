import { runFeatureWrites, runSnapshotList, runSnapshotWrite } from './actions.mjs'
import { defaultClaudeBinary } from './binaries.mjs'
import { cleanupLocks, inspectLock, storeRoot } from './diagnostics.mjs'
import { CliUsageError } from './errors.mjs'
import { validateOutput, writeJson } from './output.mjs'
import { formatStatus, readStatus } from './status.mjs'

const MANAGER_COMMANDS = new Set(['status', 'patch', 'revert', 'snapshot', 'store', 'lock'])

function parseOptions(args) {
  const options = { positional: [], binary: [], feature: [] }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--json' || argument === '--profile' || argument === '--all' || argument === '--force' || argument === '--yes' || argument === '-y') {
      options[argument === '-y' ? 'yes' : argument.slice(2)] = true
    } else if (argument === '--binary' || argument === '--feature' || argument === '--snapshot' || argument === '--snapshot-version') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new CliUsageError(`${argument} requires a value`)
      if (argument === '--binary' || argument === '--feature') options[argument.slice(2)].push(value)
      else if (argument === '--snapshot') options.snapshot = value
      else options.snapshotVersion = value
    } else if (argument.startsWith('--')) {
      throw new CliUsageError(`unknown option: ${argument}`)
    } else {
      options.positional.push(argument)
    }
  }
  return options
}

function writeStatus(status, json) {
  if (json) writeJson(validateOutput('status', status))
  else process.stdout.write(`${formatStatus(status)}\n`)
}

async function runStatus(args) {
  const options = parseOptions(args)
  if (options.positional.length > 0) throw new CliUsageError(`unexpected status argument: ${options.positional[0]}`)
  const binaries = options.binary.length > 0 ? options.binary : [defaultClaudeBinary()]
  for (const binary of binaries) writeStatus(await readStatus(binary, options), options.json)
}

function requireBinaries(options) {
  if (options.binary.length === 0) options.binary.push(defaultClaudeBinary())
  return options
}

async function runSnapshot(args) {
  const subcommand = args[0]
  if (!['save', 'list', 'rm'].includes(subcommand)) throw new CliUsageError('snapshot requires save, list, or rm')
  const options = requireBinaries(parseOptions(args.slice(1)))
  if (subcommand === 'list') {
    if (options.positional.length > 0) throw new CliUsageError(`unexpected snapshot list argument: ${options.positional[0]}`)
    const result = await runSnapshotList(options)
    if (options.json) writeJson(result)
    else for (const snapshot of result.snapshots) process.stdout.write(`${snapshot.binary} ${snapshot.version} ${snapshot.slug}${snapshot.invalid ? ' invalid' : ''}\n`)
    return
  }
  if (options.positional.length !== 1) throw new CliUsageError(`snapshot ${subcommand} requires exactly one name`)
  options.name = options.positional[0]
  return runSnapshotWrite(`snapshot-${subcommand}`, options)
}

function runStore(args) {
  const subcommand = args[0]
  const options = parseOptions(args.slice(1))
  if (subcommand !== 'root' || options.positional.length > 0 || options.binary.length > 0) {
    throw new CliUsageError('store requires: store root [--json]')
  }
  const result = storeRoot()
  if (options.json) writeJson(result)
  else process.stdout.write(`${result.root}\n`)
}

async function runLock(args) {
  const subcommand = args[0]
  if (!['inspect', 'cleanup'].includes(subcommand)) throw new CliUsageError('lock requires inspect or cleanup')
  const options = requireBinaries(parseOptions(args.slice(1)))
  if (options.positional.length > 0) throw new CliUsageError(`unexpected lock argument: ${options.positional[0]}`)
  if (subcommand === 'cleanup') return cleanupLocks(options)
  const states = []
  for (const binary of options.binary) states.push(await inspectLock(binary))
  if (options.json) {
    for (const state of states) writeJson(state)
  } else {
    for (const state of states) process.stdout.write(`${state.binary} ${state.locked ? state.owner_known ? 'locked' : 'lock exists but owner unknown' : 'unlocked'}\n`)
  }
}

async function runTui(args) {
  const options = requireBinaries(parseOptions(args))
  if (options.positional.length > 0) throw new CliUsageError(`unexpected TUI argument: ${options.positional[0]}`)
  const unsupported = ['json', 'profile', 'all', 'force', 'yes', 'snapshot', 'snapshotVersion']
    .find((name) => options[name] !== undefined)
  if (unsupported || options.feature.length > 0) {
    throw new CliUsageError('bare TTY supports only repeated --binary options; use an explicit subcommand for other options')
  }
  const [{ createProductionTuiAdapters }, { runJsTui }] = await Promise.all([
    import('../tui/adapters.mjs'),
    import('../tui/run.mjs'),
  ])
  const result = await runJsTui(createProductionTuiAdapters({ binaries: options.binary }))
  process.exitCode = result.exitCode
  return result
}

async function dispatchCcManager(args, { isTTY = process.stdin.isTTY } = {}) {
  if (['--help', '-h', 'help'].includes(args[0])) {
    process.stdout.write([
      'usage: unbun cc <status|patch|revert|snapshot|store|lock|run|introspect|patch-loader-hook> [options]',
      'manager: status|patch|revert|snapshot|store|lock',
      'runtime introspection: run|introspect|patch-loader-hook',
      '',
    ].join('\n'))
    return
  }
  const explicit = MANAGER_COMMANDS.has(args[0])
  const command = explicit ? args[0] : 'status'
  const rest = explicit ? args.slice(1) : args
  if (!explicit && isTTY) return runTui(rest)
  if (command === 'status') return runStatus(rest)
  if (command === 'patch' || command === 'revert') {
    const options = requireBinaries(parseOptions(rest))
    if (options.positional.length > 0) throw new CliUsageError(`unexpected ${command} argument: ${options.positional[0]}`)
    if (command === 'revert' && options.snapshot) return runSnapshotWrite('snapshot-restore', options)
    return runFeatureWrites(command, options)
  }
  if (command === 'snapshot') return runSnapshot(rest)
  if (command === 'store') return runStore(rest)
  if (command === 'lock') return runLock(rest)
}

export async function runCcManager(args, options) {
  try {
    return await dispatchCcManager(args, options)
  } catch (error) {
    if (!(error instanceof CliUsageError)) throw error
    console.error(`${error.code}: ${error.message}`)
    process.exitCode = error.exitCode
  }
}