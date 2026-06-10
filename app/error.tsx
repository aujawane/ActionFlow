"use client";

export default function GlobalError({
  error,
  reset
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-rose-200 bg-rose-50 p-6">
      <h2 className="text-lg font-semibold text-rose-800">Something went wrong</h2>
      <p className="mt-2 text-sm text-rose-700">
        {error.message || "Unexpected error while rendering this page."}
      </p>
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
