// In-memory Google Drive for tests: folders and files with parents.
import type { DriveClient } from "../../app/services/drive.server";

export interface FakeItem {
  id: string;
  name: string;
  parentId: string;
  kind: "folder" | "file";
  content?: string;
  mimeType?: string;
}

export function fakeDrive(options: { failOn?: (name: string) => boolean } = {}) {
  const items: FakeItem[] = [];
  let seq = 0;
  const client: DriveClient = {
    rootId: "ROOT",
    async createFolder(name, parentId) {
      if (options.failOn?.(name)) throw new Error(`Google Drive 403: no access creating ${name}`);
      const id = `F${++seq}`;
      items.push({ id, name, parentId, kind: "folder" });
      return { id };
    },
    async uploadFile(name, parentId, mimeType, content) {
      if (options.failOn?.(name)) throw new Error(`Google Drive 500: upload of ${name} failed`);
      const id = `D${++seq}`;
      items.push({ id, name, parentId, kind: "file", content, mimeType });
      return { id };
    },
  };
  /** "Org/Team/2026 Fall/Internal"-style paths of every item. */
  const paths = () =>
    items
      .map((item) => {
        const parts = [item.name];
        let parent = item.parentId;
        while (parent !== "ROOT") {
          const p = items.find((x) => x.id === parent)!;
          parts.unshift(p.name);
          parent = p.parentId;
        }
        return parts.join("/");
      })
      .sort();
  return { client, items, paths, setFail: (fn: ((name: string) => boolean) | undefined) => (options.failOn = fn) };
}
