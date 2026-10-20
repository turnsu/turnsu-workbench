import { defineAction, type ActionEvent } from "@openuidev/react-lang";
import { z } from "zod/v4";

export const CopyToClipboard = defineAction({
  name: "CopyToClipboard",
  description: "Copy text to the clipboard, e.g. a shopping list built with @Join",
  params: z.object({ text: z.string() }),
});

export const ImportFiles = defineAction({ name: "ImportFiles", description: "Select and attach files to this task through the Host.", params: z.object({}) });
export const ContinueTask = defineAction({ name: "ContinueTask", description: "Continue a known pending human confirmation; never creates a new confirmation.", params: z.object({}) });
export const actions = [CopyToClipboard, ImportFiles, ContinueTask];

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API refused (no focus, insecure origin): the textarea route still works
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/**
 * Runs this library's custom actions. Returns a promise of whether it worked,
 * or null when the event is not one of them (a built-in step the host handles).
 */
export function runLibraryAction(event: ActionEvent): Promise<boolean> | null {
  if (event.type === CopyToClipboard.name) {
    const text = (event.params as { text?: unknown }).text;
    return typeof text === "string" ? copy(text) : Promise.resolve(false);
  }
  return null;
}
