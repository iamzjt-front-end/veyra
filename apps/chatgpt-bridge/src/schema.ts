import { z } from "zod";

const id = z.string().min(1).max(128);
const text = z.string().min(1).max(8192);
const provenance = z
  .object({
    role: z.enum(["planner", "executor", "reviewer", "human", "system"]),
    surface: id,
    actor: z.string().max(256),
    at: z.string(),
    contentTrust: z.literal("untrusted"),
  })
  .strict();
export const handoffSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("handoff"),
    id,
    projectId: z.string().uuid(),
    runId: z.string().uuid(),
    provenance,
    context: z
      .object({
        goal: text,
        constraints: z.array(z.string().max(4096)).max(100),
        decisions: z
          .array(
            z
              .object({
                id,
                summary: z.string().max(4096),
                rationale: z.string().max(4096),
                provenance,
              })
              .strict(),
          )
          .max(100),
        plan: z
          .object({
            id,
            revision: z.number().int().positive(),
            summary: text,
            tasks: z
              .array(z.object({ id, description: z.string().max(4096) }).strict())
              .min(1)
              .max(100),
            acceptanceCriteria: z.array(z.string().max(4096)).min(1).max(100),
            provenance,
          })
          .strict()
          .optional(),
        currentTask: id.optional(),
      })
      .strict(),
    references: z
      .array(
        z.union([
          z
            .object({
              kind: z.literal("file"),
              path: z.string().max(4096),
              startLine: z.number().int().positive().optional(),
              endLine: z.number().int().positive().optional(),
            })
            .strict(),
          z
            .object({
              kind: z.literal("artifact"),
              id,
              runId: id,
              summary: z.string().max(2048).optional(),
            })
            .strict(),
        ]),
      )
      .max(128)
      .optional(),
    requestedVerification: z
      .array(
        z
          .object({
            id,
            kind: z.enum(["test", "lint", "typecheck", "build", "shell", "benchmark"]),
            description: z.string().max(2048).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict();

export const outputSchema = z
  .object({
    ok: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  })
  .strict();
