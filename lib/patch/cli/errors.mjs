export class CliUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliUsageError'
    this.code = 'usage_error'
    this.exitCode = 1
  }
}