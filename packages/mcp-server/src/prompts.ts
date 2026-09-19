import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { CAPABILITY_BY_NAME } from "@compositor-mcp/protocol";

export interface WorkflowStep {
  /** A catalogue operation name — registration and the prompt tests assert every step names an implemented operation. */
  operation: string;
  detail: string;
}

export interface WorkflowText {
  goal: string;
  steps: WorkflowStep[];
  notes: string[];
}

export interface WorkflowPrompt {
  name: string;
  title: string;
  description: string;
  argsSchema?: StandardSchemaWithJSON;
  build(args: Record<string, string | undefined>): WorkflowText;
}

/// Workflow recipes that expand into guidance naming real catalogue operations.
/// Keep prose free of dotted tokens that look like operation names (e.g.
/// "photo.png") — the registry-validation test scans rendered text for
/// `category.name` tokens and fails on anything the catalogue does not implement.
export const WORKFLOW_PROMPTS: WorkflowPrompt[] = [
  {
    name: "export-for-web",
    title: "Export a web-ready image",
    description: "Resize the current document for web delivery and export PNG plus JPEG variants into an authorised directory.",
    argsSchema: z.object({
      outputDirectory: z
        .string()
        .optional()
        .describe("Directory the exports are written to; must sit inside an MCP-authorised root."),
      width: z.string().optional().describe('Target width in pixels, e.g. "1600". Height scales proportionally.'),
    }),
    build: (args) => {
      const width = args.width ?? "the target width";
      const directory = args.outputDirectory ?? "the authorised output directory";
      return {
        goal: "Resize the current document for web delivery and write PNG and JPEG exports.",
        steps: [
          { operation: "app.getState", detail: "Confirm a document is open and note the current canvas size." },
          {
            operation: "document.resizeImage",
            detail: `Resample to ${width} px wide, scaling the height proportionally. Skip when the canvas is already the target size.`,
          },
          {
            operation: "preview.render",
            detail: "Inspect the resized frame. The render also refreshes the compositor://preview/latest resource.",
          },
          { operation: "document.export", detail: `Write the PNG variant into ${directory} (format "png").` },
          {
            operation: "document.export",
            detail: `Write the JPEG variant into ${directory} (format "jpeg", quality about 0.85, background "#FFFFFF").`,
          },
        ],
        notes: [
          "Steps 1–3 can share one atomic execute batch.",
          "The exports are filesystem writes: send them together in a second execute call with atomic: false — they cannot roll back.",
          "document.save writes the project file afterwards if the resized canvas should be kept.",
        ],
      };
    },
  },
  {
    name: "subject-cutout",
    title: "Cut out the subject",
    description: "Remove the background around the subject, sit the cutout over a fresh backdrop layer, then refine the mask edge.",
    argsSchema: z.object({
      layerId: z.string().optional().describe('Layer carrying the subject, or "active" (the default).'),
    }),
    build: (args) => {
      const layer = args.layerId ?? "active";
      return {
        goal: "Isolate the subject on its own masked layer over a clean backdrop.",
        steps: [
          { operation: "app.getState", detail: "Confirm a document is open and note which layer carries the subject." },
          { operation: "layer.select", detail: `Select exactly the subject layer (layerIds: ["${layer}"], target "layer").` },
          {
            operation: "filter.apply",
            detail:
              'Run kind "Remove Background" with settings {backgroundQuality: "Advanced", refineEdges: 20} for hair and fine edges. The app commits a mask that keeps the subject.',
          },
          { operation: "layer.addBlank", detail: "Insert a fresh backdrop layer." },
          { operation: "layer.move", detail: "Move it directly below the subject layer (offset -1)." },
          { operation: "pixels.fill", detail: "Fill the backdrop with the foreground colour to preview the cut edge." },
          {
            operation: "layer.featherMask",
            detail: `Soften the subject's mask edge (layerId "${layer}", radius 1–3 px) if it looks crunchy.`,
          },
          { operation: "preview.render", detail: "Inspect the composite; the PNG also lands on compositor://preview/latest." },
        ],
        notes: [
          "Steps 4–6 are optional cosmetics — the cutout itself is steps 2–3.",
          "layer.setOpacity and layer.setVisibility on the subject layer help compare before and after.",
          'Missed wisps: re-run filter.apply "Remove Background" with refineEdges raised toward 40.',
        ],
      };
    },
  },
  {
    name: "retouch-pass",
    title: "Retouch pass",
    description: "Select a blemish region and repair it with spot healing, cloning or content-aware fill — then deselect and review.",
    argsSchema: z.object({
      mode: z.string().optional().describe('Which repair step to emphasise: "heal", "clone" or "fill" (default "heal").'),
    }),
    build: (args) => {
      const mode = args.mode ?? "heal";
      const emphasis = {
        heal: "Reach for paint.spotHeal first — it is the lightest touch for small marks.",
        clone: "Reach for paint.clone first — the area has a repeating texture worth resampling.",
        fill: "Reach for pixels.contentAwareFill first — the region is too large for brush strokes.",
      }[mode] ?? "Pick the repair step per defect; the mode argument can bias this recipe.";
      return {
        goal: "Clean blemishes off the active layer with the healing, clone or content-aware fill pipeline.",
        steps: [
          { operation: "app.getState", detail: "Confirm a document is open and pick the layer to retouch." },
          { operation: "layer.select", detail: "Select that layer only — strokes land on the active layer." },
          {
            operation: "selection.polygon",
            detail: "Lasso the blemish (or selection.magicWand on a flat halo). Skip for freehand strokes.",
          },
          {
            operation: "paint.spotHeal",
            detail: 'Alternative A — stroke over small marks; mode "Proximity Match" for hard edges, "Content-Aware" otherwise.',
          },
          {
            operation: "paint.clone",
            detail: "Alternative B — resample clean texture for repeating patterns (source plus destination points).",
          },
          {
            operation: "pixels.contentAwareFill",
            detail: "Alternative C — fill the live selection for larger regions.",
          },
          { operation: "selection.none", detail: "Drop the selection so later edits are not clipped to it." },
          { operation: "preview.render", detail: "Compare the pass; compositor://preview/latest serves the PNG." },
        ],
        notes: [
          emphasis,
          "The selection and one repair step can share a single atomic execute batch.",
          "history.undo reverts the whole pass as one entry when a repair misses.",
        ],
      };
    },
  },
  {
    name: "batch-variant",
    title: "Produce a styled variant",
    description: "Duplicate the active layer, attach an adjustment look, preview it and export the variant without disturbing the original.",
    argsSchema: z.object({
      variantName: z.string().optional().describe("Name for the duplicated layer, e.g. \"Warm grade\"."),
      outputDirectory: z.string().optional().describe("Directory the variant is exported to; must be MCP-authorised."),
    }),
    build: (args) => {
      const variant = args.variantName ?? "Variant 1";
      const directory = args.outputDirectory ?? "the authorised output directory";
      return {
        goal: "Spin a styled variant of the active layer and export it without disturbing the original.",
        steps: [
          { operation: "app.getState", detail: "Confirm a document is open and note the layer to restyle." },
          { operation: "layer.duplicate", detail: "Copy the layer so the original stays untouched." },
          { operation: "layer.rename", detail: `Name the copy "${variant}".` },
          {
            operation: "adjustment.add",
            detail: 'Attach a look: kind "Gradient Map" for duotones, "Hue/Saturation" for recolours, "Grain" for texture.',
          },
          { operation: "adjustment.update", detail: "Tune the kind's typed parameters after previewing." },
          { operation: "preview.render", detail: "Review the variant; compositor://preview/latest serves the PNG." },
          {
            operation: "document.export",
            detail: `Write the variant into ${directory} — send exports with atomic: false, they cannot roll back.`,
          },
        ],
        notes: [
          "Repeat steps 2–7 per variant: one atomic execute batch for steps 2–5, then the export call.",
          "layer.setVisibility toggles variants for quick side-by-side previews.",
          "history.undo reverts a variant cleanly — each batch is one undo entry.",
        ],
      };
    },
  },
];

export function registerWorkflowPrompts(server: McpServer): void {
  for (const workflow of WORKFLOW_PROMPTS) {
    // Prompts must never name an operation the catalogue does not implement —
    // checked here at startup (loud failure) and again in the test suite.
    for (const step of workflow.build({}).steps) assertImplementedOperation(workflow.name, step.operation);
    server.registerPrompt(
      workflow.name,
      {
        title: workflow.title,
        description: workflow.description,
        ...(workflow.argsSchema ? { argsSchema: workflow.argsSchema } : {}),
      },
      (args) => ({
        description: workflow.description,
        messages: [
          {
            role: "user",
            content: { type: "text", text: renderWorkflow(workflow, (args ?? {}) as Record<string, string | undefined>) },
          },
        ],
      }),
    );
  }
}

export function renderWorkflow(workflow: WorkflowPrompt, args: Record<string, string | undefined>): string {
  const text = workflow.build(args);
  return [
    text.goal,
    "",
    "Steps — run them through the execute tool (call search with a name for its input schema):",
    ...text.steps.map((step, index) => `${index + 1}. ${step.operation} — ${step.detail}`),
    ...(text.notes.length > 0 ? ["", "Notes:", ...text.notes.map((note) => `- ${note}`)] : []),
  ].join("\n");
}

function assertImplementedOperation(promptName: string, operation: string): void {
  const capability = CAPABILITY_BY_NAME.get(operation);
  if (!capability || capability.status !== "implemented") {
    throw new Error(
      `Workflow prompt "${promptName}" references ${capability ? "non-implemented" : "unknown"} operation ${operation}.`,
    );
  }
}
