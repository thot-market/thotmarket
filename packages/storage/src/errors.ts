// Shared validation errors do not initialize database drivers.
export class DomainError extends Error {
  code: string; status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
export function ensure(condition: unknown, code: string, status = 400): asserts condition {
  if (!condition) throw new DomainError(code, status);
}
