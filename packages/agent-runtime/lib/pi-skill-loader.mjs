import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/**
 * Public Agent-domain boundary for Pi skill parsing.
 * Backend callers must not depend on Pi's internal files or dependency layout.
 */
export function loadPiSkillsFromDir(options) {
  return loadSkillsFromDir(options);
}
