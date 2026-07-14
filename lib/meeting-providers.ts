import type { MeetingPlatform } from "@/lib/meeting-platform";

type DirectMeetingPlatform = Exclude<MeetingPlatform, "unknown">;

type CreatedProviderMeeting = {
  meetingUrl: string;
  platform: DirectMeetingPlatform;
};

function getRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Configure provider credentials before starting meetings.`);
  }
  return value;
}

async function createZoomAccessToken() {
  const clientId = getRequiredEnv("ZOOM_CLIENT_ID");
  const clientSecret = getRequiredEnv("ZOOM_CLIENT_SECRET");
  const accountId = getRequiredEnv("ZOOM_ACCOUNT_ID");
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(
    `https://zoom.us/oauth/token?${new URLSearchParams({
      grant_type: "account_credentials",
      account_id: accountId
    })}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`
      }
    }
  );
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    reason?: string;
  };

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.reason || data.error || `Zoom token request failed with status ${response.status}.`
    );
  }

  return data.access_token;
}

export async function createZoomMeeting(title?: string): Promise<CreatedProviderMeeting> {
  const accessToken = await createZoomAccessToken();
  const response = await fetch("https://api.zoom.us/v2/users/me/meetings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      topic: title?.trim() || "Parfait Meeting",
      type: 1,
      settings: {
        join_before_host: true
      }
    })
  });
  const data = (await response.json().catch(() => ({}))) as {
    join_url?: string;
    message?: string;
  };

  if (!response.ok || !data.join_url) {
    throw new Error(data.message || `Zoom meeting creation failed with status ${response.status}.`);
  }

  return { meetingUrl: data.join_url, platform: "zoom" };
}

async function createGoogleAccessToken(refreshTokenOverride?: string | null) {
  const clientId = getRequiredEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getRequiredEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = refreshTokenOverride?.trim() || getRequiredEnv("GOOGLE_REFRESH_TOKEN");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        `Google access token request failed with status ${response.status}.`
    );
  }

  return data.access_token;
}

export async function createGoogleMeetMeeting(
  refreshToken?: string | null
): Promise<CreatedProviderMeeting> {
  const accessToken = await createGoogleAccessToken(refreshToken);
  const response = await fetch("https://meet.googleapis.com/v2/spaces", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });
  const data = (await response.json().catch(() => ({}))) as {
    meetingUri?: string;
    name?: string;
    error?: { message?: string };
  };

  if (!response.ok || !data.meetingUri) {
    throw new Error(
      data.error?.message || `Google Meet creation failed with status ${response.status}.`
    );
  }

  return { meetingUrl: data.meetingUri, platform: "google_meet" };
}

export async function createProviderMeeting(
  platform: DirectMeetingPlatform,
  title?: string,
  options?: { googleRefreshToken?: string | null }
): Promise<CreatedProviderMeeting> {
  if (platform === "zoom") {
    return createZoomMeeting(title);
  }

  return createGoogleMeetMeeting(options?.googleRefreshToken);
}
