export class SetupError extends Error {
  step = "";

  constructor(step: string, message: string) {
    super(message);
    this.name = "SetupError";
    this.step = step;
  }
}
