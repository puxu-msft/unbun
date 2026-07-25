import React from 'react'
import { Box, Text, render } from 'ink'

function BadLayout() {
  const columns = process.stdout.columns ?? 80
  return <Box width={columns + 80} justifyContent="space-between">
    <Text>UNBUN CC</Text>
    <Text>RIGHT-EDGE</Text>
  </Box>
}

const instance = render(<BadLayout />)
setTimeout(() => instance.unmount(), 250)
await instance.waitUntilExit()