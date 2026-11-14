export interface Thing {
  a: string;
}

export async function getA(thing: Thing): Promise<string> {
  return thing.a;
}
