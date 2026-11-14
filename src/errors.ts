/** Throw from an API function to send `status` and `message` to the client. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`ApiError status must be an integer from 400 to 599, got ${status}`);
    }
    this.name = "ApiError";
    this.status = status;
  }
}

export function errorResponse(error: unknown, methodKey: string): { status: number; message: string } {
  if (error instanceof ApiError) return { status: error.status, message: error.message };
  console.error(`❌ Gild: ${methodKey || "request"} failed:`, error);
  return { status: 500, message: "Internal server error" };
}
