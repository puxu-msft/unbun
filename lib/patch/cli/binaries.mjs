import { realpathSync } from 'node:fs'

import { CliUsageError } from './errors.mjs'

export function defaultClaudeBinary() {
  const executable = Bun.which('claude')
  if (!executable) throw new CliUsageError('could not locate claude binary; pass --binary explicitly')
  return realpathSync(executable)
}