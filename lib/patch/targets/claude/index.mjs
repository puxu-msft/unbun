import { FeatureRegistry } from '../../core/registry.mjs'
import { agentModelFeature } from './agent-model.mjs'
import { channelsFeature } from './channels.mjs'
import { sourceExecFeature } from './source-exec.mjs'

export { agentModelFeature, channelsFeature, sourceExecFeature }

export const claudeFeatureRegistry = new FeatureRegistry([
  sourceExecFeature,
  agentModelFeature,
  channelsFeature,
])