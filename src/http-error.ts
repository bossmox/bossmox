/**
 * A refusal with the HTTP status the browser gets and a sentence it shows. The server maps this one type to its
 * answer in one place (review #64). AuthError is the kind for sign-in: a refused password, a lockout, no permission.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
