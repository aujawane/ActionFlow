/** In-memory stand-in for the service-role client (tables + the RPCs B1 calls), so the real
 * v1 and v2 topic code paths can run side by side. SQL semantics of the RPCs themselves are
 * proven separately against PostgreSQL (meeting-analysis-v2*-database.test.ts). */
type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number };

export type Write = { table: string; op: "insert" | "update" | "delete" | "rpc"; name?: string };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  writes: Write[] = [];
  sequence = 0;
  /** Error for any meeting_topics INSERT: v1's .insert() receives it; the v2 RPC applies the
   * SQL boundary (class 22/23/42 -> TF001, anything else surfaces unchanged). */
  rejectTopicInsert: { code: string; message: string } | null = null;
  constructor(seed: Record<string, Row[]>) {
    for (const [table, rows] of Object.entries(seed)) this.tables[table] = rows.map((row) => ({ ...row }));
  }
  rows(table: string) {
    return (this.tables[table] ??= []);
  }
  id(table: string) {
    this.sequence += 1;
    return `${table}-${this.sequence}`;
  }
  from(table: string) {
    return new FakeQuery(this, table);
  }
  async rpc(name: string, args: Record<string, unknown>): Promise<Result> {
    this.writes.push({ table: name, op: "rpc", name });
    try {
      if (name === "replace_meeting_topic_analysis_v2") return { data: this.replace(args), error: null };
      if (name.endsWith("_meeting_analysis_job_unit") || name === "mark_meeting_analysis_job_unit_running") {
        return { data: this.mutateUnit(name, args), error: null };
      }
      throw Object.assign(new Error(`Unknown RPC ${name}`), { code: "42883" });
    } catch (error) {
      return { data: null, error: { message: (error as Error).message, code: (error as { code?: string }).code } };
    }
  }
  private currentJob(jobId: unknown, generation: unknown) {
    const job = this.rows("meeting_analysis_jobs").find((row) => row.id === jobId);
    if (!job) throw Object.assign(new Error("Analysis job does not exist"), { code: "P0002" });
    const meeting = this.rows("meetings").find((row) => row.id === job.meeting_id);
    if (job.pipeline_version !== 2) throw Object.assign(new Error("requires pipeline version 2"), { code: "22023" });
    if (job.generation !== meeting?.execution_graph_generation || job.generation !== generation || job.status === "stale") {
      throw Object.assign(new Error("Stale analysis generation"), { code: "55000" });
    }
    if (job.status !== "queued" && job.status !== "running") {
      throw Object.assign(new Error("Analysis job is terminal"), { code: "55000" });
    }
    return job;
  }
  /** B0 mutate_meeting_analysis_job_unit: first completed result wins. */
  private mutateUnit(name: string, args: Record<string, unknown>) {
    this.currentJob(args.p_job_id, args.p_generation);
    const units = this.rows("meeting_analysis_job_units");
    let unit = units.find((row) => row.job_id === args.p_job_id && row.stage === args.p_stage && row.unit_key === args.p_unit_key);
    if (unit?.status === "completed") return { ...unit };
    if (name === "mark_meeting_analysis_job_unit_running") {
      if (!unit) {
        unit = { job_id: args.p_job_id, stage: args.p_stage, unit_key: args.p_unit_key, result: null, error: null, attempt: 0 };
        units.push(unit);
      }
      Object.assign(unit, { status: "running", attempt: Math.max(Number(unit.attempt), Number(args.p_attempt)) });
      return { ...unit };
    }
    if (!unit || unit.status !== "running") throw Object.assign(new Error("Unit must be running"), { code: "55000" });
    const completed = name === "complete_meeting_analysis_job_unit";
    Object.assign(unit, { status: completed ? "completed" : "failed", result: completed ? args.p_result : null, error: completed ? null : args.p_error });
    return { ...unit };
  }
  /** JS mirror of replace_meeting_topic_analysis_v2 (all-or-nothing on a cloned snapshot). */
  private replace(args: Record<string, unknown>) {
    const job = this.currentJob(args.p_job_id, args.p_generation);
    const topicsInput = args.p_topics as Array<Row & { insights: Row[] }>;
    if (topicsInput.some((topic, index) => topic.topic_index !== index)) {
      throw Object.assign(new Error("Topic ordinals must be contiguous and ordered from 0"), { code: "22023" });
    }
    const rejection = this.rejectTopicInsert;
    if (rejection && topicsInput.length > 0) {
      if (["22", "23", "42"].includes(rejection.code.slice(0, 2))) {
        throw Object.assign(new Error(`Canonical topic insert rejected (${rejection.code}): ${rejection.message}`), { code: "TF001" });
      }
      throw Object.assign(new Error(rejection.message), { code: rejection.code });
    }
    const meetingId = job.meeting_id;
    const keep = (table: string) => this.rows(table).filter((row) => row.meeting_id !== meetingId);
    const topics: Row[] = [];
    const insights: Row[] = [];
    for (const { insights: topicInsights, ...topic } of topicsInput) {
      const row: Row = { ...topic, id: this.id("meeting_topics"), meeting_id: meetingId };
      topics.push(row);
      for (const insight of topicInsights) {
        insights.push({ ...insight, id: this.id("extracted_insights"), meeting_id: meetingId, topic_id: row.id, topic_index: row.topic_index });
      }
    }
    for (const insight of args.p_meeting_insights as Row[]) {
      insights.push({ ...insight, id: this.id("extracted_insights"), meeting_id: meetingId, topic_id: null, topic_index: null });
    }
    this.tables.meeting_topics = [...keep("meeting_topics"), ...topics];
    this.tables.extracted_insights = [...keep("extracted_insights"), ...insights.map(({ topic_index: _ignored, ...row }) => row)];
    return { topics, insights, dropped_insight_topic_indexes: [], meeting_insights_dropped: false };
  }
}

class FakeQuery implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private filters: Array<(row: Row) => boolean> = [];
  private payload: Row[] = [];
  private patch: Row = {};
  private returning = false;
  private head = false;
  private mode: "many" | "single" | "maybe" = "many";
  private sortColumn: string | null = null;
  private max: number | null = null;
  constructor(private db: FakeDb, private table: string) {}
  select(_columns?: string, options?: { head?: boolean }) {
    if (this.op === "select") this.head = Boolean(options?.head);
    else this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
  delete() { this.op = "delete"; return this; }
  eq(column: string, value: unknown) { this.filters.push((row) => row[column] === value); return this; }
  neq(column: string, value: unknown) { this.filters.push((row) => row[column] !== value); return this; }
  is(column: string, value: unknown) { this.filters.push((row) => (row[column] ?? null) === value); return this; }
  ilike(column: string, value: string) { this.filters.push((row) => String(row[column]).toLowerCase() === value.toLowerCase()); return this; }
  in(column: string, values: unknown[]) { this.filters.push((row) => values.includes(row[column])); return this; }
  order(column: string) { this.sortColumn = column; return this; }
  limit(count: number) { this.max = count; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  then<T1 = Result, T2 = never>(resolve?: ((value: Result) => T1 | PromiseLike<T1>) | null, reject?: ((reason: unknown) => T2 | PromiseLike<T2>) | null) {
    return Promise.resolve().then(() => this.execute()).then(resolve, reject);
  }
  private matches() {
    return this.db.rows(this.table).filter((row) => this.filters.every((filter) => filter(row)));
  }
  private execute(): Result {
    if (this.op !== "select") this.db.writes.push({ table: this.table, op: this.op });
    if (this.op === "insert") {
      if (this.table === "meeting_topics" && this.db.rejectTopicInsert) {
        return { data: null, error: { ...this.db.rejectTopicInsert } };
      }
      const inserted = this.payload.map((row) => ({ id: this.db.id(this.table), created_at: "2026-10-27T00:00:00.000Z", ...row }));
      this.db.rows(this.table).push(...inserted);
      return { data: this.returning ? inserted.map((row) => ({ ...row })) : null, error: null };
    }
    if (this.op === "delete") {
      const removed = new Set(this.matches());
      this.db.tables[this.table] = this.db.rows(this.table).filter((row) => !removed.has(row));
      return { data: null, error: null };
    }
    if (this.op === "update") {
      const updated = this.matches();
      for (const row of updated) Object.assign(row, this.patch);
      return { data: this.returning ? updated.map((row) => ({ ...row })) : null, error: null };
    }
    let rows = this.matches().map((row) => ({ ...row }));
    if (this.sortColumn) {
      const column = this.sortColumn;
      rows = rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])));
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    if (this.head) return { data: null, error: null, count: rows.length };
    if (this.mode === "single") {
      return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "not exactly one row" } };
    }
    if (this.mode === "maybe") return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

export function installFakeSupabase(client: object, db: () => FakeDb) {
  Object.assign(client, {
    from: (table: string) => db().from(table),
    rpc: (name: string, args: Record<string, unknown>) => db().rpc(name, args)
  });
}
