import { createContext, Fragment, useContext, useMemo, type ReactNode } from "react";
import { cn } from "../lib/utils.js";
import { parseSubagentLink, splitSubagentText } from "@/lib/markdownSubagentLink.js";
import type { OpenSubagentSideTabRequest } from "@/lib/workspaceSidePane.js";

interface SubagentLinkScope {
  parentSessionId: string;
  rootSessionId?: string | null;
  onOpen: (request: OpenSubagentSideTabRequest) => void;
}

const SubagentLinkContext = createContext<SubagentLinkScope | null>(null);

/** Scope comes from the rendered conversation, never from a globally selected task. */
export function SubagentLinkProvider({
  parentSessionId,
  rootSessionId,
  onOpen,
  children,
}: {
  parentSessionId?: string | null;
  rootSessionId?: string | null;
  onOpen?: SubagentLinkScope["onOpen"];
  children: ReactNode;
}) {
  const value = useMemo(
    () => (parentSessionId && onOpen ? { parentSessionId, rootSessionId, onOpen } : null),
    [parentSessionId, rootSessionId, onOpen],
  );
  return <SubagentLinkContext.Provider value={value}>{children}</SubagentLinkContext.Provider>;
}

/** Context is read inside the link, so Streamdown's memoized renderer cannot capture an old parent. */
export function SubagentLink({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  const scope = useContext(SubagentLinkContext);
  if (!scope || !parseSubagentLink(id)) return <span>{children}</span>;
  return (
    <button
      type="button"
      className={cn(
        "wrap-anywhere cursor-pointer bg-transparent p-0 text-left text-ui-base font-medium text-icon-blue no-underline decoration-dotted underline-offset-4 hover:underline",
        className,
      )}
      onClick={(event) => {
        scope.onOpen({
          parentSessionId: scope.parentSessionId,
          rootSessionId: scope.rootSessionId ?? scope.parentSessionId,
          childSessionId: id,
          subagentType: "",
          title: (event.currentTarget.textContent ?? "").slice(0, 256),
        });
      }}
    >
      {children}
    </button>
  );
}

/** Preserve plaintext rendering of thinking; only the explicitly supported reference gains an action. */
export function SubagentReferenceText({ text }: { text: string }) {
  const parts = useMemo(() => splitSubagentText(text), [text]);
  return parts.map((part, index) =>
    "text" in part ? (
      <Fragment key={index}>{part.text}</Fragment>
    ) : (
      <SubagentLink key={index} id={part.id}>
        {part.label}
      </SubagentLink>
    ),
  );
}
