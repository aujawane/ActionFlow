export default function AppLoading() {
  return (
    <div className="space-y-4">
      <div className="h-10 w-48 animate-pulse rounded-lg bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
        <div className="h-24 animate-pulse rounded-xl bg-slate-200" />
      </div>
      <div className="h-64 animate-pulse rounded-xl bg-slate-200" />
    </div>
  );
}
