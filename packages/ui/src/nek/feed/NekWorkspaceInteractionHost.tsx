import { NekInteractionHost } from "@/nek/interactions/NekInteractionHost.js";
import { useNekAgentFeed } from "./nekAgentFeed.js";

export function NekWorkspaceInteractionHost({ workspacePath }: { workspacePath: string }) {
  const feed = useNekAgentFeed();
  return (
    <NekInteractionHost
      sessionKey={workspacePath}
      respondNekInteraction={feed.respond}
    />
  );
}
