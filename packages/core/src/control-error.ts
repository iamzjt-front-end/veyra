export class RunControlError extends Error {
  override readonly name = "RunControlError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
