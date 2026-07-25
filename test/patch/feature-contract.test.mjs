import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { Feature } from '../../lib/patch/core/feature.mjs'
import { FeatureRegistry } from '../../lib/patch/core/registry.mjs'
import { closeFeatures, validateFeatureRemoval } from '../../lib/patch/core/dependencies.mjs'

const ROOT = path.resolve(import.meta.dir, '../..')
const VECTOR_ROOT = path.join(ROOT, 'contract', 'vectors', 'feature-claude-v1', 'fixtures')
const dependencyInput = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'dependency-input.json'), 'utf8'))
const dependencyExpected = JSON.parse(readFileSync(path.join(VECTOR_ROOT, 'dependency-expected.json'), 'utf8'))

const REQUIRED_METHODS = [
  'detect',
  'probe_windows',
  'detect_windows',
  'observe_substates',
  'replay_substates',
  'apply',
]

function methods({ reverse = true } = {}) {
  const implementation = Object.fromEntries(REQUIRED_METHODS.map((name) => [name, () => {}]))
  if (reverse) implementation.reverse = () => {}
  return implementation
}

function feature(name, requires = [], options = {}) {
  return new Feature({
    name,
    title: name,
    description: `${name} fixture`,
    requires,
    reversible: options.reversible ?? true,
    ...methods({ reverse: options.reverse ?? true }),
  })
}

function frozenRegistry() {
  return new FeatureRegistry(
    dependencyInput.registry_order.map((name) =>
      feature(name, dependencyInput.requires[name], {
        reversible: name !== 'channels',
        reverse: name !== 'channels',
      }),
    ),
  )
}

describe('Feature contract', () => {
  for (const missing of REQUIRED_METHODS) {
    test(`rejects a feature missing ${missing}`, () => {
      const implementation = methods()
      delete implementation[missing]
      expect(() => new Feature({
        name: 'incomplete',
        title: 'Incomplete',
        description: 'Missing one required method',
        requires: [],
        reversible: false,
        ...implementation,
      })).toThrow(missing)
    })
  }

  test('requires reverse exactly when reversible is true', () => {
    expect(() => feature('reversible-without-reverse', [], { reverse: false })).toThrow('reverse')
    expect(() => feature('irreversible-with-reverse', [], { reversible: false })).toThrow('reverse')
    expect(() => feature('irreversible', [], { reversible: false, reverse: false })).not.toThrow()
  })

  test('rejects duplicate requires declarations', () => {
    expect(() => feature('duplicate-requires', ['base', 'base'])).toThrow('duplicate requires')
  })
})

describe('FeatureRegistry dependency graph', () => {
  test('preserves the frozen claude-v1 order and requires declarations', () => {
    const registry = frozenRegistry()
    expect(registry.names()).toEqual(dependencyInput.registry_order)
    expect(Object.fromEntries(registry.features().map((entry) => [entry.name, entry.requires]))).toEqual(dependencyInput.requires)
  })

  test('rejects duplicate and unknown features', () => {
    expect(() => new FeatureRegistry([feature('a'), feature('a')])).toThrow('duplicate')
    expect(() => new FeatureRegistry([feature('a', ['missing'])])).toThrow('unknown feature')
    expect(() => frozenRegistry().get('missing')).toThrow('unknown feature')
  })

  test('rejects dependency cycles', () => {
    expect(() => new FeatureRegistry([
      feature('a', ['b']),
      feature('b', ['c']),
      feature('c', ['a']),
    ])).toThrow('cycle')
  })

  test('orders dependencies before dependents and uses registry order for ties', () => {
    const registry = new FeatureRegistry([
      feature('dependent', ['base']),
      feature('independent'),
      feature('base'),
    ])
    expect(registry.topologicalNames()).toEqual(['independent', 'base', 'dependent'])
  })
})

describe('dependency closure and removal', () => {
  test('matches the frozen closure oracle without generating expected results', () => {
    const registry = frozenRegistry()
    expect(dependencyInput.requests.map((request) => closeFeatures(registry, request))).toEqual(dependencyExpected.closures)
  })

  test('deduplicates requests and returns deterministic registry-topological order', () => {
    const registry = frozenRegistry()
    expect(closeFeatures(registry, ['channels', 'source-exec', 'channels', 'agent-model'])).toEqual([
      'source-exec',
      'agent-model',
      'channels',
    ])
    expect(closeFeatures(registry, ['agent-model', 'channels'])).toEqual(closeFeatures(registry, ['channels', 'agent-model']))
  })

  test('rejects unknown requested features', () => {
    expect(() => closeFeatures(frozenRegistry(), ['missing'])).toThrow('unknown feature')
  })

  test('allows removing source-exec while agent-model remains enabled', () => {
    const result = validateFeatureRemoval(frozenRegistry(), ['source-exec', 'agent-model'], 'source-exec')
    expect(result).toEqual(dependencyExpected.remove_source_exec_while_agent_model_enabled)
  })

  test('rejects removing source-exec while channels remains enabled', () => {
    const result = validateFeatureRemoval(frozenRegistry(), ['source-exec', 'channels'], 'source-exec')
    expect(result).toEqual(dependencyExpected.remove_source_exec_while_channels_enabled)
  })
})