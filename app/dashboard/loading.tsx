export default function DashboardLoading() {
  return (
    <div className="space-y-5">
      <div className="h-8 w-44 animate-pulse rounded bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div className="h-36 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-36 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-36 animate-pulse rounded-xl bg-slate-200" />
      </div>
    </div>
  );
}
