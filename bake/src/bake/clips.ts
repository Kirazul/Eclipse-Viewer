import type { ModelKind } from "@eclipse/format";
import { animName } from "../m2/animNames";
import type { Sequence } from "../m2/model";

/**
 * Which sequences are worth an object. A body has 389 and storage is a hard limit, so
 * what goes is what nobody opens a viewer to see: engine-internal poses, a second copy
 * of a combat move for the other hand, and one class's cast of what every class casts.
 * What stays is everything a viewer plays: stands, moves, emotes, attacks, sitting.
 */
const BODY_INTERNAL = new RegExp(
  "^(" +
    [
      "Anim \\d+", // AnimationData has no name for it
      "BarServer", "BarTend", "Carriage", "Carried", "Carry", "Cinematic", "FacePose", "Art(Bow|Dual|Fists|Main|Off|Shield)Loop",
      "CustomSpell", "Falconeer", "MountChopper", "MountCrouch", "MountExtraWide", "MountWide", "MountSelf", "Reclined",
      "Load(Bow|Dart|Joust|Rifle)", "Hold(Bow|Dart|Joust|Rifle|Thrown)", "Hover$",
      "CombatAbility", "Monk(Heal|Defense|Offense)", "(Dk|Dru|Loc|Mag|Pal|Pri|Sha)(Cast|Ready|Spell|Hover|Summon)",
      ".*Off(Pierce)?$", ".*Channel$",
    ].join("|") +
    ")",
);

/** A mount is ridden, flown and looked at: its combat set is hundreds of clips no stage asks for. */
const MOUNT_KEEP = /^(Stand|Walk|WalkBackwards|Run|RunBackwards|ShuffleLeft|ShuffleRight|Jump|JumpStart|JumpEnd|JumpLandRun|Fall|Mount|MountSpecial|MountFlight.*|Swim|SwimIdle|SwimBackwards|SwimLeft|SwimRight|FlyStand|FlyWalk|FlyRun|Fly|Hover|Sit.*|Sleep.*|Death|EmoteDance|EmoteRoar|BattleRoar|Spin|TakeOff.*|Land.*|FlyIdle)$/;

export function bodyClipWanted(id: number): boolean {
  return !BODY_INTERNAL.test(animName(id));
}

export function mountClipWanted(id: number, variation: number): boolean {
  const name = animName(id);
  // The stand's variations are its fidgets: they are the point of a stage.
  if (variation > 0 && name !== "Stand") return false;
  return MOUNT_KEEP.test(name);
}

export function clipWanted(kind: ModelKind): (seq: Sequence) => boolean {
  if (kind === "mount") return (seq) => mountClipWanted(seq.id, seq.variation);
  if (kind === "body") return (seq) => bodyClipWanted(seq.id);
  return () => true;
}
