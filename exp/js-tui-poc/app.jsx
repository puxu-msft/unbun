import React, {useEffect, useState} from 'react'
import {Box, Text, render, useApp, useFocus, useFocusManager, useInput, useStdout} from 'ink'

const initialRows = [
  {id: 'stable-source', path: '/opt/claude/stable', version: '2.1.217', feature: 'source-exec', state: 'clean', target: false},
  {id: 'stable-agent', path: '/opt/claude/stable', version: '2.1.217', feature: 'agent-model', state: 'patched', target: true},
  {id: 'stable-channels', path: '/opt/claude/stable', version: '2.1.217', feature: 'channels', state: 'mixed', target: false},
  {id: 'canary-source', path: '/srv/claude/canary', version: '2.1.218', feature: 'source-exec', state: 'unsupported', target: false},
  {id: 'canary-agent', path: '/srv/claude/canary', version: '2.1.218', feature: 'agent-model', state: 'clean', target: false},
]

function useTerminalSize() {
  const {stdout} = useStdout()
  const readSize = () => ({columns: stdout.columns ?? 80, rows: stdout.rows ?? 24})
  const [size, setSize] = useState(readSize)
  useEffect(() => {
    const resize = () => setSize(readSize())
    stdout.on('resize', resize)
    return () => stdout.off('resize', resize)
  }, [stdout])
  return size
}

function App() {
  const {exit} = useApp()
  const {enableFocus} = useFocusManager()
  const {isFocused} = useFocus({autoFocus: true})
  const size = useTerminalSize()
  const [rows, setRows] = useState(initialRows)
  const [filter, setFilter] = useState('')
  const [filtering, setFiltering] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [phase, setPhase] = useState('READY')
  const [refresh, setRefresh] = useState(0)
  const [event, setEvent] = useState('NONE')
  const visible = rows.filter((row) => `${row.path} ${row.feature}`.toLowerCase().includes(filter.toLowerCase()))
  const active = visible[Math.min(cursor, Math.max(0, visible.length - 1))]

  useEffect(() => enableFocus(), [enableFocus])

  useEffect(() => {
    if (cursor >= visible.length) setCursor(Math.max(0, visible.length - 1))
  }, [cursor, visible.length])

  useInput((input, key) => {
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
      setCursor((current) => Math.max(0, Math.min(visible.length - 1, current + delta)))
      return
    }
    if (input === ' ') {
      if (active?.state === 'unsupported') {
        setEvent('UNSUPPORTED_DISABLED')
        return
      }
      setRows((current) => current.map((row) => row.id === active?.id ? {...row, target: !row.target} : row))
      setEvent('ROW_TOGGLED')
      return
    }
    if (input === 'a') {
      const selectable = visible.filter((row) => row.state !== 'unsupported')
      const nextTarget = selectable.some((row) => !row.target)
      const visibleIds = new Set(selectable.map((row) => row.id))
      setRows((current) => current.map((row) => visibleIds.has(row.id) ? {...row, target: nextTarget} : row))
      return
    }
    if (key.return) {
      const targets = new Map(rows.map((row) => [row.id, row.target]))
      setPhase('APPLYING')
      setTimeout(() => {
        setRows((current) => current.map((row) => row.state === 'unsupported' ? row : {...row, state: targets.get(row.id) ? 'patched' : 'clean'}))
        setRefresh((current) => current + 1)
        setPhase('DONE')
      }, 300)
      return
    }
  }, {isActive: isFocused})

  return <Box flexDirection="column" width={size.columns}>
    <Box width={process.env.POC_BAD_LAYOUT === '1' ? size.columns + 80 : size.columns} justifyContent="space-between">
      <Text bold>UNBUN JS TUI POC</Text>
      <Text>RIGHT-EDGE</Text>
    </Box>
    <Text wrap="truncate">VIEWPORT:{size.columns}x{size.rows} FOCUS:{isFocused ? 'ON' : 'OFF'} RAW:{process.stdin.isRaw ? 'ON' : 'OFF'} MODE:{filtering ? 'FILTER' : 'COMMAND'} FILTER:{filter || '-'}</Text>
    <Text>PHASE:{phase} REFRESH:{refresh} VISIBLE:{visible.length} EVENT:{event}</Text>
    {visible.map((row, index) => <Text key={row.id} color={index === cursor ? 'cyan' : undefined}>
      {index === cursor ? '>' : ' '} [{row.target ? 'x' : ' '}] {row.path} {row.feature} STATE:{row.state}{row.state === 'unsupported' ? ' DISABLED' : ''}
    </Text>)}
    <Text dimColor>/: filter | space: row | a: visible | enter: apply | q/esc: quit</Text>
  </Box>
}

const instance = render(<App />, {exitOnCtrlC: true})
await instance.waitUntilExit()