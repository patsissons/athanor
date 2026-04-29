import { z } from "zod";
import { DevServerConfigSchema } from "./eval-spec.js";

export const AppSpecSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  guidelines: z.array(z.string()).optional(),
  devServer: DevServerConfigSchema.optional(),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;
