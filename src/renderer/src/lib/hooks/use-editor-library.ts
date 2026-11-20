import { useEffect, useState } from "react";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { api } from "@renderer/lib/api";
import { toast } from "@renderer/lib/toast";
import type { MediaAsset } from "@shared/types/media";

type LibraryKind = "image" | "video";

const ADD_ERROR = { image: "style.addImageError", video: "style.addVideoError" } as const;

export type EditorLibrary = {
  assets: readonly MediaAsset[];
  /** While the file picker and the import run: the «Add…» button shows it. */
  adding: boolean;
  /** Picks files, imports them and lists the library again. Resolves to the first file added, which the editor
   *  selects: the operator picked a file in order to use it, not to then find it in a dropdown. `null` when nothing
   *  was added (picker cancelled, or the import failed and said so). */
  add: () => Promise<MediaAsset | null>;
};

/**
 * One media library as a style editor's background picker sees it (scenes, plates, the verse's look, song themes).
 * Read on open rather than kept in a store: it is one query, only the open editor wants it, and it must reflect
 * whatever the operator added since the last time they were there. On `open` alone: song themes listed both libraries
 * again after every save, because their listing shared an effect with the themes (2026-11-15 audit, X14).
 */
export function useEditorLibrary(open: boolean, kind: LibraryKind, logTag: string): EditorLibrary {
  const t = useT();
  const [assets, setAssets] = useState<readonly MediaAsset[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    void api.library
      .list(kind)
      .then(setAssets)
      .catch((error: unknown) => console.warn(`[${logTag}] could not list the ${kind} library`, error));
  }, [open, kind, logTag]);

  async function add(): Promise<MediaAsset | null> {
    setAdding(true);
    try {
      const paths = await api.files.pick(kind, true);
      if (paths.length === 0) return null;
      const added = await api.library.add(paths, kind);
      setAssets(await api.library.list(kind));
      return added[0] ?? null;
    } catch (error) {
      console.warn(`[${logTag}] could not add ${kind}s`, error);
      toast.danger(t(ADD_ERROR[kind]));
      return null;
    } finally {
      setAdding(false);
    }
  }

  return { assets, adding, add };
}
