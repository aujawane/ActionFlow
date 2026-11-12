/**
 * The one server-side loader for "give me this meeting's COMPLETE transcript".
 *
 * PostgREST caps every response at its configured max-rows (1,000 by default), and a plain
 * `.select("*").eq("meeting_id", id)` silently stops there: no error, just a truncated array. A
 * long meeting was therefore analysed, searched and displayed from only its first 1,000 segments.
 * Every consumer that expects the whole transcript must go through this helper instead.
 *
 * Contract
 * - Rows are fetched in explicit `.range()` pages, in a deterministic total database order:
 *   `timestamp ASC NULLS LAST, id ASC`. `id` is unique, so the order is total and a row can neither
 *   repeat nor be skipped across a page boundary. Imported transcripts may have a null timestamp;
 *   those rows sort together at the end and are separated by `id`, never filtered out or turned
 *   into a date.
 * - That database order exists only to make paging stable. It is NOT the transcript order. Callers
 *   still pass the full combined result through `canonicalTranscriptOrder`, which ranks by the
 *   persisted import index / Recall timing / timestamp and breaks every tie by id. Sorting after
 *   the pages are joined means no page boundary can influence the final order.
 * - The first page also asks for an exact row count. Paging advances by the number of rows that
 *   actually came back (not by the requested size) and stops once that many rows are loaded, so a
 *   project configured with a max-rows lower than the page size still loads everything instead of
 *   mistaking a capped page for the last one. Without a count it falls back to the "short page
 *   means done" rule.
 * - A failed page, an empty page before the counted total, a duplicated id, or a final length that
 *   disagrees with the count (the transcript was replaced mid-load) is returned as an error. The
 *   loader never hands back a partial transcript as if it were complete.
 * - There is no cap on the number of segments. `MAX_TRANSCRIPT_PAGES` only bounds the loop so a
 *   misbehaving API cannot spin forever; at 1,000 rows per page it is 5,000,000 segments.
 */
/** Equal to PostgREST's default max-rows, so a default project needs exactly one request per
 * 1,000 segments. */
export const TRANSCRIPT_PAGE_SIZE = 1000;
/** Runaway-loop guard only (see above); not a limit on transcript size. */
export const MAX_TRANSCRIPT_PAGES = 5000;

type PageResult = {
  data: unknown[] | null;
  error: { message: string } | null;
  count?: number | null;
};

/** The slice of a Supabase query builder this loader needs. Any real `SupabaseClient` satisfies it. */
type PageQuery = {
  eq: (column: string, value: unknown) => PageQuery;
  order: (column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) => PageQuery;
  range: (from: number, to: number) => PromiseLike<PageResult>;
};

export type TranscriptPageClient = {
  from: (table: string) => {
    select: (columns: string, options?: { count?: "exact" }) => PageQuery;
  };
};

export type TranscriptLoadResult<Row> =
  | { data: Row[]; error: null }
  | { data: null; error: { message: string } };

export async function loadAllMeetingTranscriptSegments<Row = Record<string, unknown>>(input: {
  meetingId: string;
  client: TranscriptPageClient;
  /** Defaults to every column. Include `id` so duplicate detection can run. */
  columns?: string;
  pageSize?: number;
}): Promise<TranscriptLoadResult<Row>> {
  const pageSize = input.pageSize ?? TRANSCRIPT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    return { data: null, error: { message: `Invalid transcript page size: ${pageSize}` } };
  }

  const rows: Row[] = [];
  let total: number | null = null;
  let finished = false;

  for (let page = 0; page < MAX_TRANSCRIPT_PAGES && !finished; page += 1) {
    const from = rows.length;
    const to = from + pageSize - 1;
    const query = input.client
      .from("transcript_segments")
      // The count is requested once, on the first page; it is the authority on "how many exist".
      .select(input.columns ?? "*", page === 0 ? { count: "exact" } : undefined)
      .eq("meeting_id", input.meetingId)
      .order("timestamp", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true });
    const result = await query.range(from, to);
    if (result.error) {
      return {
        data: null,
        error: {
          message: `Failed to load transcript segments (page ${page + 1}, rows ${from}-${to}): ${result.error.message}`
        }
      };
    }

    const batch = (result.data ?? []) as Row[];
    if (page === 0) total = typeof result.count === "number" ? result.count : null;
    rows.push(...batch);

    if (batch.length === 0) finished = true;
    else if (total !== null) finished = rows.length >= total;
    else finished = batch.length < pageSize;
  }

  if (!finished) {
    return {
      data: null,
      error: { message: `Transcript did not finish loading within ${MAX_TRANSCRIPT_PAGES} pages.` }
    };
  }
  if (total !== null && rows.length !== total) {
    return {
      data: null,
      error: {
        message: `Transcript segment count changed while loading: counted ${total}, loaded ${rows.length}. Retry.`
      }
    };
  }

  const seen = new Set<string>();
  for (const row of rows) {
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) {
      return { data: null, error: { message: `Transcript load returned segment ${id} more than once. Retry.` } };
    }
    seen.add(id);
  }

  return { data: rows, error: null };
}

/** Convenience for the common case: the server-side admin client. Imported lazily so modules that
 * only need the pure helper never construct a client. */
export async function loadAllMeetingTranscriptSegmentsAdmin<Row = Record<string, unknown>>(input: {
  meetingId: string;
  columns?: string;
  pageSize?: number;
}): Promise<TranscriptLoadResult<Row>> {
  const { supabaseAdmin } = await import("@/lib/supabase/admin");
  return loadAllMeetingTranscriptSegments<Row>({
    ...input,
    client: supabaseAdmin as unknown as TranscriptPageClient
  });
}
