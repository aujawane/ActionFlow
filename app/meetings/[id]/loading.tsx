export default function MeetingDetailLoading() {
  return (
    <div className="space-y-4">
      <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
      </div>
      <div className="h-28 animate-pulse rounded-xl bg-slate-200" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="h-80 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-80 animate-pulse rounded-xl bg-slate-200" />
      </div>
      <div className="h-80 animate-pulse rounded-xl bg-slate-200" />
    </div>
  );
}
