import { AudioOutputsGroup, StripsGroup } from "@renderer/components/shared/settings-groups/sound-groups";

/** Settings ▸ Sound (owner, 2026-11-15): the audio strips, where each bus sounds, and the level what goes live
 *  starts at (it was in Projection). The welcome and «Novedades» show the same groups. */
export function SoundSection() {
  return (
    <div className="flex flex-col gap-8">
      <StripsGroup />
      <AudioOutputsGroup />
    </div>
  );
}
