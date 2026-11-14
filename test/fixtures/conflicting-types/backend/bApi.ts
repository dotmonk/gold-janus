export interface Thing {
  b: number;
}

export async function getB(thing: Thing): Promise<number> {
  return thing.b;
}
