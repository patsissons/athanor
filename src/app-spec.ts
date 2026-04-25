import { z } from "zod";

export const AppSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  guidelines: z.array(z.string()).optional(),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;
