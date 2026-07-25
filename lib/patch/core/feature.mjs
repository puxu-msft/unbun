const REQUIRED_METHODS = [
  'detect',
  'probe_windows',
  'detect_windows',
  'observe_substates',
  'replay_substates',
  'apply',
]

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Feature ${field} must be a non-empty string`)
  }
}

export class Feature {
  constructor(definition) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new TypeError('Feature definition must be an object')
    }

    const { name, title, description, requires, reversible } = definition
    requireString(name, 'name')
    requireString(title, 'title')
    requireString(description, 'description')
    if (!Array.isArray(requires) || requires.some((dependency) => typeof dependency !== 'string' || dependency.length === 0)) {
      throw new TypeError('Feature requires must be an array of non-empty strings')
    }
    if (new Set(requires).size !== requires.length) {
      throw new TypeError(`Feature ${name} has duplicate requires`)
    }
    if (typeof reversible !== 'boolean') {
      throw new TypeError('Feature reversible must be a boolean')
    }

    for (const method of REQUIRED_METHODS) {
      if (typeof definition[method] !== 'function') {
        throw new TypeError(`Feature ${name} must implement ${method}`)
      }
    }
    if (reversible && typeof definition.reverse !== 'function') {
      throw new TypeError(`Feature ${name} must implement reverse when reversible`)
    }
    if (!reversible && definition.reverse !== undefined) {
      throw new TypeError(`Feature ${name} cannot implement reverse when irreversible`)
    }

    this.name = name
    this.title = title
    this.description = description
    this.requires = Object.freeze([...requires])
    this.reversible = reversible
    for (const method of REQUIRED_METHODS) this[method] = definition[method]
    if (reversible) this.reverse = definition.reverse
    Object.freeze(this)
  }
}

export const FEATURE_REQUIRED_METHODS = Object.freeze([...REQUIRED_METHODS])