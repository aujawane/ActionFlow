"use client";

export default function GlobalError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-rose-200 bg-rose-50 p-6">
      <h2 className="text-lg font-semibold text-rose-800">Something went wrong</h2>
      <p className="mt-2 text-sm text-rose-700">
        Parfait ran into an unexpected error loading this page. Try again, or come back in a
        moment.
      </p>
      {error.digest ? (
        <p className="mt-2 text-xs text-rose-500">Reference: {error.digest}</p>
      ) : null}
      <button
        type="button"
        onClick={() => reset()}
        className="mt-4 rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700"
      >
        Try again
      </button>
    </div>
  );
}
