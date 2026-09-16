import { queryOptions } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { TENANT_ID } from "@/lib/constants";
import { fetchConversationSummaries } from "./conversations";
import { fetchEscalationCases } from "./escalations";
import { fetchDocuments } from "./documents";
import { fetchRequestErrors, type HealthIndicator } from "./errors";

const DAY_MS = 24 * 60 * 60 * 1000;
const INGESTION_WINDOW_MS = 7 * DAY_MS;

export type OverviewMetrics = {
  activeConversations: number;
  totalConversations: number;
  openEscalations: number;
  readyForAgent: number;
  documents: number;
  failedIngestions: number;
  recentErrors: number;
  totalErrors: number;
  health: HealthIndicator[];
};

const OPEN_STATUSES = new Set(["awaiting_customer_info", "ready_for_agent", "in_progress"]);

/**
 * Read-path signal for vector search health.
 *
 * Returns true if an assistant turn with a positive retrieval_score was
 * written in the last 24h. That proves the query embedding + Pinecone
 * round-trip is actually completing in production — not just that the
 * Pinecone API responds to a ping.
 *
 * Fails closed: any query error (RLS, missing column, network) returns
 * false, so we degrade to "unknown" rather than lie about being healthy.
 */
async function hasRecentRetrieval(sinceIso: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("conversation_turns")
    .select("timestamp")
    .eq("tenant_id", TENANT_ID)
    .eq("role", "assistant")
    .gt("retrieval_score", 0)
    .gte("timestamp", sinceIso)
    .limit(1);

  if (error) return false;
  return (data ?? []).length > 0;
}

function computeVectorHealth(
  hasRecentWrite: boolean,
  hasRecentRead: boolean,
): HealthIndicator {
  if (hasRecentWrite && hasRecentRead) {
    return {
      area: "Vector search",
      state: "healthy",
      detail: "Ingestion within 7d and retrieval within 24h",
    };
  }
  if (hasRecentWrite) {
    return {
      area: "Vector search",
      state: "degraded",
      detail: "Documents ingested in the last 7d; no successful retrieval in the last 24h",
    };
  }
  if (hasRecentRead) {
    return {
      area: "Vector search",
      state: "degraded",
      detail: "Retrieval active; no ingestion in the last 7d",
    };
  }
  return {
    area: "Vector search",
    state: "unknown",
    detail: "No ingestion or retrieval activity in the last 7d",
  };
}

export async function fetchOverview(): Promise<OverviewMetrics> {
  const since = Date.now() - DAY_MS;
  const sinceIso = new Date(since).toISOString();
  const ingestionSince = Date.now() - INGESTION_WINDOW_MS;

  const [conversations, cases, documents, errors, recentRetrieval] = await Promise.all([
    fetchConversationSummaries(),
    fetchEscalationCases(),
    fetchDocuments(),
    fetchRequestErrors(200),
    hasRecentRetrieval(sinceIso),
  ]);

  const recentErrors = errors.filter(
    (e) => e.occurred_at && new Date(e.occurred_at).getTime() >= since,
  );
  const failedIngestions = documents.filter((d) => d.status.toLowerCase() === "failed").length;

  // Write path derived from documents we already loaded — no extra query
  const hasRecentWrite = documents.some(
    (d) => d.last_ingested && new Date(d.last_ingested).getTime() >= ingestionSince,
  );

  const health: HealthIndicator[] = [
    {
      area: "Chat API",
      state: recentErrors.length === 0 ? (conversations.length > 0 ? "healthy" : "unknown") : "degraded",
      detail:
        recentErrors.length > 0
          ? `${recentErrors.length} workflow error(s) in the last 24h`
          : conversations.length > 0
            ? "Conversation turns written, no errors logged in 24h"
            : "No conversation turns recorded yet",
    },
    {
      area: "Knowledge ingestion",
      state: documents.length === 0 ? "unknown" : failedIngestions > 0 ? "degraded" : "healthy",
      detail:
        documents.length === 0
          ? "No ingestion runs recorded"
          : failedIngestions > 0
            ? `${failedIngestions} document(s) failed ingestion`
            : `${documents.length} document(s) ingested successfully`,
    },
    {
      area: "Database",
      state: "healthy",
      detail: "Operational tables readable from this console",
    },
    computeVectorHealth(hasRecentWrite, recentRetrieval),
  ];

  return {
    activeConversations: conversations.filter(
      (c) => new Date(c.last_activity).getTime() >= since,
    ).length,
    totalConversations: conversations.length,
    openEscalations: cases.filter((c) => OPEN_STATUSES.has(c.status.toLowerCase())).length,
    readyForAgent: cases.filter((c) => c.status.toLowerCase() === "ready_for_agent").length,
    documents: documents.length,
    failedIngestions,
    recentErrors: recentErrors.length,
    totalErrors: errors.length,
    health,
  };
}

export const overviewQuery = () =>
  queryOptions({
    queryKey: ["overview", TENANT_ID],
    queryFn: fetchOverview,
    staleTime: 15_000,
  });
