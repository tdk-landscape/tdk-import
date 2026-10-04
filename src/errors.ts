/** A user-facing failure: the message, plus what to try. */
export class ImportError extends Error {
  constructor(
    message: string,
    public suggestions: string[] = [],
  ) {
    super(message);
    this.name = "ImportError";
  }
}
