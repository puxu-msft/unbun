export function closeFeatures(registry, requestedFeatures) {
  if (!Array.isArray(requestedFeatures)) {
    throw new TypeError('requested features must be an array')
  }

  const selected = new Set()
  const visit = (name) => {
    const feature = registry.get(name)
    if (selected.has(name)) return
    for (const dependency of feature.requires) visit(dependency)
    selected.add(name)
  }
  for (const name of requestedFeatures) visit(name)

  return registry.topologicalNames().filter((name) => selected.has(name))
}

export function validateFeatureRemoval(registry, enabledFeatures, featureToRemove) {
  if (!Array.isArray(enabledFeatures)) {
    throw new TypeError('enabled features must be an array')
  }
  registry.get(featureToRemove)

  const remaining = [...new Set(enabledFeatures)]
    .filter((name) => name !== featureToRemove)
  for (const name of remaining) registry.get(name)

  const stillRequired = remaining.some((name) =>
    closeFeatures(registry, [name]).includes(featureToRemove),
  )
  if (stillRequired) {
    return { allowed: false, code: 'feature_dependency_conflict', exit: 1 }
  }
  return { allowed: true, code: null, exit: 0 }
}