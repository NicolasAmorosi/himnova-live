import { ConfirmModal } from "@renderer/components/shared/modal";
import { ProgramUsages } from "@renderer/components/shared/program-usages";
import { useT } from "@renderer/lib/i18n/i18n-provider";
import { deleteSong, type SongDeleteTarget } from "@renderer/lib/actions/songs";

type DeleteSongConfirmProps = {
  /** `null` means closed — also the song asked about, so no separate `open`. */
  target: SongDeleteTarget | null;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
};

/** «Eliminar» a library song, asked first: the saved programs that sing it,
 *  whether it is live, and that its file — when it is tied to one — stays on
 *  disk (the app never deletes a file of the operator's). The editor's «⋯»
 *  and the Songs tab's ✕ (owner, 2026-11-05) ask the same question. */
export function DeleteSongConfirm({ target, onOpenChange, onDeleted }: DeleteSongConfirmProps) {
  const t = useT();
  const inUse = (target?.usages.length ?? 0) > 0;
  const body = !target ? null : inUse ? (
    <ProgramUsages
      intro={t("songs.deleteInUseIntro")}
      usages={target.usages}
      warning={target.live ? t("songs.deleteInUseLiveWarning") : t("songs.deleteInUseWarning")}
    />
  ) : target.live ? (
    t("songs.deleteLiveBody")
  ) : (
    t("songs.deleteBody")
  );
  return (
    <ConfirmModal
      confirmLabel={inUse ? t("songs.deleteAnyway") : t("common.delete")}
      danger
      description={
        target?.file ? (
          <div className="flex flex-col gap-2">
            <div>{body}</div>
            <p>{t("songs.deleteKeepsFile")}</p>
          </div>
        ) : (
          body
        )
      }
      onConfirm={async () => {
        if (target && (await deleteSong(target.songId, inUse))) onDeleted?.();
      }}
      onOpenChange={onOpenChange}
      open={target !== null}
      title={t("songs.deleteTitle")}
    />
  );
}
