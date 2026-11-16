/**
 * A prerequisite of a test run that is not met (a missing build, missing generated files).
 *
 * The message is the whole report, written for the person at the terminal: what is missing and
 * the command that provides it. The stack is cut down to that line, since the frames below it
 * (the setup file, then the test runner's internals) would bury it and say nothing more.
 */
export class SetupError extends Error {
  override name = 'SetupError';

  constructor(message: string) {
    super(message);
    this.stack = `${this.name}: ${message}`;
  }
}
