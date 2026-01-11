import z from "zod.js";

const RunPipelineInputSchema = z.object({
  repo: z.string().min(1, "repo is required"),
  test_command: z.string().min(1, "test_command is required"),
  init: z.boolean().optional().default(true),
  timeout_sec: z
    .number()
    .int()
    .positive()
    .max(7200)
    .optional()
    .default(1800),
  max_log_lines: z.number().int().positive().max(2000).optional().default(200),
  max_diff_files: z.number().int().positive().max(200).optional().default(20),
  max_diff_lines_per_file: z.number().int().positive().max(2000).optional().default(400)
});

export { RunPipelineInputSchema };
