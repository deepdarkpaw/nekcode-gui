import { z } from "zod";

/** Private main ↔ window Host messages. Renderer receives only the existing remote API. */
export const remoteDesktopMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("remote-credential-request"),
    requestId: z.string(),
    operation: z.enum(["load", "save", "delete"]),
    key: z.string().min(1).max(4096),
    value: z.string().max(65536).optional(),
  }),
  z.object({
    type: z.literal("remote-credential-result"),
    requestId: z.string(),
    value: z.string().nullable().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("remote-reconnect-command"),
    connectionId: z.string(),
    action: z.enum(["retry", "cancel"]),
  }),
  z.object({
    type: z.literal("remote-connection-status"),
    event: z.discriminatedUnion("kind", [
      z.object({ connectionId: z.string(), kind: z.literal("connected") }),
      z.object({ connectionId: z.string(), kind: z.literal("disconnected") }),
      z.object({
        connectionId: z.string(),
        kind: z.literal("reconnecting"),
        attempt: z.number(),
        max: z.number(),
        nextDelayMs: z.number(),
      }),
      z.object({ connectionId: z.string(), kind: z.literal("failed"), message: z.string() }),
      z.object({ connectionId: z.string(), kind: z.literal("cancelled") }),
    ]),
  }),
]);

export type RemoteDesktopMessage = z.infer<typeof remoteDesktopMessageSchema>;
