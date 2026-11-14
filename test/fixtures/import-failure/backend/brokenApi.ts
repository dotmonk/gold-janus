const failOnImport = true;
if (failOnImport) throw new Error("broken at import");

export async function ping(): Promise<string> {
  return "pong";
}
