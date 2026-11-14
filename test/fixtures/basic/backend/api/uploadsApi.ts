import type { UploadedFile } from "gold-janus";

const seenTempPaths: string[] = [];

export async function upload(file: UploadedFile, label: string): Promise<{ label: string; text: string }> {
  seenTempPaths.push(file.tempFilePath);
  return { label, text: (await file.readAsBuffer()).toString("utf8") };
}

export async function uploadThenFail(file: UploadedFile): Promise<void> {
  seenTempPaths.push(file.tempFilePath);
  throw new Error("handler failed");
}

export async function seenUploads(): Promise<string[]> {
  return seenTempPaths;
}
