import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'

import { planLabel, planTargets, visibleRows } from './model.mjs'

function useTerminalSize() {
  const { stdout } = useStdout()
  const readSize = () => ({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
  const [size, setSize] = useState(readSize)
  useEffect(() => {
    const resize = () => setSize(readSize())
    stdout.on('resize', resize)
    return () => stdout.off('resize', resize)
  }, [stdout])
  return size
}

function stateBadge(state) {
  return state.toUpperCase()
}

function progressText(snapshot) {
  const { progress } = snapshot
  if (snapshot.phase === 'loading') return 'Probing binaries...'
  if (snapshot.phase === 'refreshing') return 'Refreshing status...'
  if (snapshot.phase === 'applying') return `Applying ${progress.completed}/${progress.total} | ok=${progress.succeeded} failed=${progress.failed}`
  if (snapshot.phase === 'done') return `Done: ${progress.succeeded}/${progress.total} succeeded | refreshed=${snapshot.refreshGeneration}`
  if (snapshot.phase === 'error') return 'Probe failed'
  return 'Ready'
}

function groupPlan(plans, path) {
  return plans.find((plan) => plan.binary === path)
}

export function TuiApp({ controller }) {
  const { exit } = useApp()
  const size = useTerminalSize()
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
  const [filter, setFilter] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [cursor, setCursor] = useState(0)
  const rows = visibleRows(snapshot.state, filter)
  const active = rows[Math.min(cursor, Math.max(0, rows.length - 1))]
  const plans = planTargets(snapshot.state)
  const busy = ['loading', 'applying', 'refreshing'].includes(snapshot.phase)

  useEffect(() => { void controller.load() }, [controller])
  useEffect(() => {
    if (cursor >= rows.length) setCursor(Math.max(0, rows.length - 1))
  }, [cursor, rows.length])

  useInput((input, key) => {
    if (busy && (key.escape || input === 'q')) return
    if (key.escape) {
      exit()
      return
    }
    if (filtering) {
      if (key.return) {
        setFiltering(false)
        return
      }
      if (key.backspace || key.delete) {
        setFilter((current) => current.slice(0, -1))
        setCursor(0)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setFilter((current) => current + input)
        setCursor(0)
      }
      return
    }
    if (input === 'q') {
      exit()
      return
    }
    if (input === '/') {
      setFilter('')
      setFiltering(true)
      setCursor(0)
      return
    }
    if (key.upArrow || key.downArrow) {
      const delta = key.upArrow ? -1 : 1
      setCursor((current) => Math.max(0, Math.min(rows.length - 1, current + delta)))
      return
    }
    if (input === ' ') {
      if (active) controller.toggle(active.id)
      return
    }
    if (input === 'a') {
      controller.toggleVisible(filter)
      return
    }
    if (key.return && !busy) void controller.submit()
  })

  const visibleIds = new Set(rows.map((row) => row.id))
  return <Box flexDirection="column" width={size.columns}>
    <Box width={size.columns} justifyContent="space-between">
      <Text bold>UNBUN CC</Text>
      <Text>RIGHT-EDGE</Text>
    </Box>
    <Text wrap="truncate">VIEWPORT:{size.columns}x{size.rows} MODE:{filtering ? 'FILTER' : 'COMMAND'} FILTER:{filter || '-'} PHASE:{snapshot.phase.toUpperCase()}</Text>
    {snapshot.state.groups.map((group) => {
      const groupRows = group.rows.filter((row) => visibleIds.has(row.id))
      if (groupRows.length === 0) return null
      const plan = groupPlan(plans, group.path)
      return <Box key={group.path} flexDirection="column">
        <Text wrap="truncate" bold>{group.path} v{group.version ?? '?'} baseline:{group.hasBaseline ? 'yes' : 'no'}{plan ? ` -> ${planLabel(plan)}` : ''}</Text>
        {groupRows.map((row) => <Text key={row.id} wrap="truncate" color={row.id === active?.id ? 'cyan' : undefined} dimColor={!row.selectable}>
          {row.id === active?.id ? '>' : ' '} [{row.target ? 'x' : ' '}] {row.feature} {stateBadge(row.state)}{row.selectable ? '' : ' DISABLED'}
        </Text>)}
      </Box>
    })}
    {rows.length === 0 && <Text color="yellow">No matches</Text>}
    {snapshot.errors.map((error, index) => <Text key={`${error.binary}:${error.code}:${index}`} color="red" wrap="truncate">ERROR {error.code}: {error.message}</Text>)}
    <Text wrap="truncate">{progressText(snapshot)}</Text>
    <Text wrap="truncate">{plans.length} pending | checked=target | enter submit | space toggle | a visible</Text>
    <Text dimColor wrap="truncate">/: filter | arrows: move | q/esc: quit</Text>
  </Box>
}