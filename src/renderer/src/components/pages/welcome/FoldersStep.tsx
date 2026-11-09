import { useT } from "@renderer/lib/i18n/i18n-provider";
import { Button, Callout, FieldGroup, FieldRow, Icon, IconButton, Token, Tooltip, type IconName } from "@renderer/components/ui";
import { addLinkedFolder, removeLinkedFolder } from "@renderer/lib/actions/library-folders";
import { linkSongFolder, unlinkSongFolder } from "@renderer/lib/actions/songs";
import { useSettingsStore } from "@renderer/stores/settings.store";
import { ASSET_KINDS, type AssetKind } from "@shared/constants";
import { StepLayout } from "./StepLayout";

type FolderKind = AssetKind | "songs";

const KIND_ICONS: Record<FolderKind, IconName> = { video: "video", image: "image", audio: "audio", ppt: "ppt", songs: "song" };

/** The last part of a path, whichever separator the system writes. */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** The computer's folders each tab shows (Media's four kinds and Songs), linked with the same actions the
 *  tabs' folder button runs — so the tab opens on the folder just linked, as it does there. */
export function FoldersStep() {
  const t = useT();
  const media = useSettingsStore((s) => s.settings["library.linkedFolders"]);
  const songs = useSettingsStore((s) => s.settings["songs.linkedFolders"]);
  const kinds: readonly FolderKind[] = [...ASSET_KINDS, "songs"];

  return (
    <StepLayout subtitle={t("welcome.folders.subtitle")} title={t("welcome.folders.title")}>
      <FieldGroup title={t("welcome.folders.group")}>
        {kinds.map((kind) => {
          const linked = kind === "songs" ? songs : media[kind];
          return (
            <FieldRow
              description={
                linked.length === 0 ? (
                  t("welcome.folders.none")
                ) : (
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {linked.map((path) => (
                      <Token className="max-w-full pr-0.5" key={path}>
                        <Icon className="size-3.5" name="folder" />
                        <Tooltip content={path}>
                          <span className="truncate">{folderName(path)}</span>
                        </Tooltip>
                        <IconButton
                          aria-label={t("welcome.folders.unlink", { name: folderName(path) })}
                          onClick={() => void (kind === "songs" ? unlinkSongFolder(path) : removeLinkedFolder(kind, path))}
                          size="xs"
                          title={t("welcome.folders.unlink", { name: folderName(path) })}
                          variant="ghost"
                        >
                          <Icon className="size-3.5" name="close" />
                        </IconButton>
                      </Token>
                    ))}
                  </span>
                )
              }
              key={kind}
              label={
                <span className="flex items-center gap-2">
                  <Icon className="text-muted-foreground" name={KIND_ICONS[kind]} />
                  {t(`welcome.folders.kinds.${kind}`)}
                </span>
              }
            >
              <Button
                onClick={() => void (kind === "songs" ? linkSongFolder() : addLinkedFolder(kind))}
                size="sm"
                variant="outline"
              >
                <Icon name="folderPlus" />
                {t("welcome.folders.link")}
              </Button>
            </FieldRow>
          );
        })}
      </FieldGroup>
      <Callout>{t("welcome.folders.tip")}</Callout>
    </StepLayout>
  );
}
