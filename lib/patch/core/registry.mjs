import { Feature } from './feature.mjs'

function unknownFeature(name) {
  return new Error(`unknown feature: ${name}`)
}

export class FeatureRegistry {
  #features
  #byName
  #topologicalNames

  constructor(features) {
    if (!features || typeof features[Symbol.iterator] !== 'function') {
      throw new TypeError('FeatureRegistry features must be iterable')
    }

    this.#features = [...features]
    this.#byName = new Map()
    for (const feature of this.#features) {
      if (!(feature instanceof Feature)) {
        throw new TypeError('FeatureRegistry entries must be Feature instances')
      }
      if (this.#byName.has(feature.name)) {
        throw new Error(`duplicate feature: ${feature.name}`)
      }
      this.#byName.set(feature.name, feature)
    }

    for (const feature of this.#features) {
      for (const dependency of feature.requires) {
        if (!this.#byName.has(dependency)) throw unknownFeature(dependency)
      }
    }
    this.#topologicalNames = this.#sortTopologically()
  }

  #sortTopologically() {
    const ordered = []
    const emitted = new Set()

    while (ordered.length < this.#features.length) {
      const next = this.#features.find((feature) =>
        !emitted.has(feature.name)
        && feature.requires.every((dependency) => emitted.has(dependency)),
      )
      if (!next) {
        const unresolved = this.#features
          .map((feature) => feature.name)
          .filter((name) => !emitted.has(name))
        throw new Error(`feature dependency cycle: ${unresolved.join(', ')}`)
      }
      emitted.add(next.name)
      ordered.push(next.name)
    }

    return Object.freeze(ordered)
  }

  get(name) {
    const feature = this.#byName.get(name)
    if (!feature) throw unknownFeature(name)
    return feature
  }

  has(name) {
    return this.#byName.has(name)
  }

  names() {
    return this.#features.map((feature) => feature.name)
  }

  features() {
    return [...this.#features]
  }

  topologicalNames() {
    return [...this.#topologicalNames]
  }
}