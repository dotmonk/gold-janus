export interface Item {
  id: number;
  label: string;
  tags?: string[];
}

export type Status = "open" | "closed";
