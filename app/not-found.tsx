import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <h2 className="text-xl font-semibold text-slate-900">Page not found</h2>
      <p className="mt-2 text-sm text-slate-600">
        The page you requested does not exist or may have been removed.
      </p>
      <Link
        href="/dashboard"
        className="mt-4 inline-flex rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
