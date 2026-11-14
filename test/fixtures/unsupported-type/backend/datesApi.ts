export async function when(moment: Date): Promise<string> {
  return moment.toISOString();
}
