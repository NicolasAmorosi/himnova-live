import { useEffect, useState } from "react";
import { api } from "@renderer/lib/api";
import { useBibleStore } from "@renderer/stores/bible.store";
import type { BundledBibleDTO } from "@shared/types/bible";

/** The Bibles that ship with the app, read again whenever the installed list changes (an install, a delete, an
 *  import), which is what moves a version between the two lists. The setter is for a caller that reads it itself. */
export function useBundledBibles(): [readonly BundledBibleDTO[], (list: readonly BundledBibleDTO[]) => void] {
  const versions = useBibleStore((s) => s.versions);
  const [bundled, setBundled] = useState<readonly BundledBibleDTO[]>([]);
  useEffect(() => {
    let current = true;
    api.bible
      .bundled()
      .then((list) => {
        if (current) setBundled(list);
      })
      .catch((error: unknown) => console.error("[bible] bundled list failed", error));
    return () => {
      current = false;
    };
  }, [versions]);
  return [bundled, setBundled];
}
