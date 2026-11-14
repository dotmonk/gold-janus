export async function now(): Promise<Date> {
  return new Date();
}

export async function* ticks(): AsyncGenerator<Date> {
  yield new Date();
}

export async function fine(): Promise<{ at: string }> {
  return { at: new Date().toISOString() };
}
