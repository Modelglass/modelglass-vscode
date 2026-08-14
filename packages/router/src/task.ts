import * as vscode from "vscode";
import type { Subtask, SubtaskTag } from "./lib.js";

/**
 * MVP task definition (SCO-211): a single subtask, not the CLI's full
 * multi-subtask Task/JSON-file shape. Reproducing the CLI's whole routing
 * table is a bigger UI surface for comparatively low v1 value — deferred to
 * a later version. This asks "what should I use for the next chunk of work,"
 * once.
 */

const CODING_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "typescriptreact",
  "javascriptreact",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "kotlin",
]);

/** Infers a starting tag from the active editor's language, if any. Always overridable. */
function inferTag(): SubtaskTag {
  const languageId = vscode.window.activeTextEditor?.document.languageId;
  if (languageId && CODING_LANGUAGES.has(languageId)) return "coding";
  if (languageId === "markdown" || languageId === "plaintext") return "writing";
  return "general";
}

const TAG_LABELS: Record<SubtaskTag, string> = {
  coding: "Coding — ranked by SWE-bench Verified",
  writing: "Writing — ranked by instruction-following",
  general: "General",
};

/**
 * Prompts for a task description, then a tag (pre-selected from the active
 * file's language, always changeable). Returns undefined if the user cancels
 * either step.
 */
export async function promptForSubtask(): Promise<Subtask | undefined> {
  const description = await vscode.window.showInputBox({
    title: "Modelglass: Route Task",
    prompt: "Briefly describe what you're about to do",
    placeHolder: "e.g. Implement rate-limit middleware with unit tests",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "Description can't be empty"),
  });
  if (!description) return undefined;

  const inferred = inferTag();
  const picked = await vscode.window.showQuickPick(
    (Object.keys(TAG_LABELS) as SubtaskTag[]).map((tag) => ({
      label: TAG_LABELS[tag],
      tag,
      description: tag === inferred ? "(inferred from active file)" : undefined,
      picked: tag === inferred,
    })),
    {
      title: "Modelglass: Task Type",
      placeHolder: TAG_LABELS[inferred],
    },
  );
  if (!picked) return undefined;

  return { description: description.trim(), tag: picked.tag };
}
