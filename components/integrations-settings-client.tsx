"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type IntegrationStatus = {
  provider: string;
  connected: boolean;
  provider_account_email: string | null;
  scope: string | null;
  expires_at: string | null;
  updated_at: string | null;
};

type IntegrationsSettingsClientProps = {
  googleIntegration: IntegrationStatus | null;
  statusMessage?: string | null;
  errorMessage?: string | null;
};

export function IntegrationsSettingsClient({
  googleIntegration,
  statusMessage,
  errorMessage
}: IntegrationsSettingsClientProps) {
  const router = useRouter();
  const [disconnecting, setDisconnecting] = useState(false);
  const [message, setMessage] = useState<string | null>(statusMessage ?? errorMessage ?? null);
  const connected = Boolean(googleIntegration?.connected);

  async function disconnectGoogle() {
    const confirmed = window.confirm("Disconnect Google Meet from Parfait?");
    if (!confirmed) return;

    setDisconnecting(true);
    setMessage(null);
    const response = await fetch("/api/integrations/google", { method: "DELETE" });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    setDisconnecting(false);

    if (!response.ok) {
      setMessage(data.error ?? "Failed to disconnect Google.");
      return;
    }

    setMessage("Google disconnected.");
    router.refresh();
  }

  return (
    <section className="space-y-6">
      <div className="premium-card p-6">
        <p className="text-sm font-semibold text-brand-700">Account Settings</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
          Integrations
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Connect provider accounts so Parfait can create meetings and send the Recall bot.
        </p>
      </div>

      {message ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            errorMessage
              ? "border-rose-200 bg-rose-50 text-rose-700"
              : "border-brand-100 bg-brand-50 text-brand-800"
          }`}
        >
          {message}
        </div>
      ) : null}

      <section className="premium-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Google Meet</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Required for Start Google Meet. Parfait requests permission to create Google Meet
              spaces and stores the refresh token server-side.
            </p>
            <div className="mt-4 space-y-1 text-sm text-slate-600">
              <p>
                Status:{" "}
                <span className={connected ? "font-semibold text-brand-700" : "font-semibold"}>
                  {connected ? "Connected" : "Not connected"}
                </span>
              </p>
              {googleIntegration?.provider_account_email ? (
                <p>Account: {googleIntegration.provider_account_email}</p>
              ) : null}
              {googleIntegration?.updated_at ? (
                <p>
                  Updated:{" "}
                  {new Intl.DateTimeFormat("en", {
                    dateStyle: "medium",
                    timeStyle: "short"
                  }).format(new Date(googleIntegration.updated_at))}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <a href="/api/integrations/google/start" className="premium-button">
              {connected ? "Reconnect Google" : "Connect Google"}
            </a>
            {connected ? (
              <button
                type="button"
                onClick={disconnectGoogle}
                disabled={disconnecting}
                className="secondary-button"
              >
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </section>
  );
}
