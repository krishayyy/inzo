export class RelayError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

export const notFound = (message: string) => new RelayError(message, 404, "not_found");
export const badRequest = (message: string) => new RelayError(message, 400, "bad_request");
export const conflict = (message: string) => new RelayError(message, 409, "conflict");
export const forbidden = (message: string) => new RelayError(message, 403, "forbidden");
export const gone = (message: string) => new RelayError(message, 410, "gone");
