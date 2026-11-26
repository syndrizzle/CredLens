import { Badge } from "@/components/ui/badge";
import type { EvidenceState } from "./api";

// The state is always written out; colour only separates Supported from the three gap states.
function EvidenceBadge({ state }: { state: EvidenceState }) {
  return <Badge variant={state === "Supported" ? "secondary" : "outline"}>{state}</Badge>;
}

export { EvidenceBadge };
