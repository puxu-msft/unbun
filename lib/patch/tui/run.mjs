import React from 'react'
import { render } from 'ink'

import { createTuiController } from './controller.mjs'
import { TuiApp } from './app.jsx'

const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[H'
const LEAVE_ALTERNATE_SCREEN = '\u001b[?25h\u001b[?1049l'

export async function runJsTui(adapters, { stdout = process.stdout } = {}) {
  const controller = createTuiController(adapters)
  stdout.write(ENTER_ALTERNATE_SCREEN)
  try {
    const instance = render(React.createElement(TuiApp, { controller }), { stdout, exitOnCtrlC: true })
    await instance.waitUntilExit()
  } finally {
    stdout.write(LEAVE_ALTERNATE_SCREEN)
  }
  const snapshot = controller.snapshot()
  return {
    exitCode: snapshot.errors.reduce((highest, error) => Math.max(highest, error.exitCode ?? 2), 0),
    phase: snapshot.phase,
    errors: snapshot.errors,
  }
}