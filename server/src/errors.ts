/**
 * The one error type the API translates into an HTTP response.
 *
 * It lives in its own module so that both `domain.ts` (permission and assignment policy) and
 * `service.ts` (workflow) can throw it without importing each other.
 */
export class AppError extends Error {
  status: number;
  code: string;
  fields?: Record<string, string>;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}
